import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Logger } from 'pino';

import { AgentDispatchService } from '../agents/agent-dispatch.service';
import { AgentConnectionManager } from '../agents/connection-manager.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/authenticated-request';
import { AppError, ErrorCode } from '../common/errors';
import { LOGGER } from '../config/tokens';
import { Database } from '../database/database';
import {
  actions,
  agents,
  containers,
  hosts,
  stackDeployments,
  stackOperations,
  stackRevisions,
  stacks,
} from '../database/schema';
import { DetailService } from '../discovery/detail.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { EventsService } from '../events/events.service';
import { MutationRegistry } from '../operations/mutation-registry';
import {
  ObservedRuntime,
  RuntimeFingerprint,
  StackLifecycleKind,
  StackLifecycleOutcome,
  classifyStackLifecycle,
} from './stack-lifecycle';
import { UNRESOLVED_DEPLOYMENT, stackKey } from './stack-deployment.service';
import { assertNotArchived } from '../inventory/host-archive';

/** What the caller is told about an operation that reached its state. */
export interface StackOperationOutcome {
  readonly operationId: string;
  readonly stackId: string;
  readonly operation: StackLifecycleKind;
  readonly status: 'succeeded';
  readonly services: readonly { serviceName: string; state: string | null }[];
}

interface RequestContext {
  readonly sourceIp?: string;
  readonly userAgent?: string;
  readonly requestId?: string;
}

/**
 * Starting, stopping and restarting a stack that is already deployed.
 *
 * A different thing from applying a revision, deliberately kept apart from it.
 * Nothing here compiles a Compose file, decrypts an environment, creates a
 * container or recreates one, and neither the newest saved revision nor the
 * deployed one changes. What changes is whether the containers that are already
 * there are running.
 *
 * That has a consequence worth stating: a stack can be started and stopped when
 * its Compose source no longer compiles, when the compiler binary is missing,
 * and when the encryption key is unavailable. The path an operator needs in an
 * incident is the one with the fewest things in it.
 *
 * The shape is the deployment service's, because the failure modes are the same.
 * The intention is written and committed before the agent is asked for anything,
 * the agent is asked outside any transaction, and what actually happened is
 * established by reading the host rather than by believing the reply.
 */
@Injectable()
export class StackLifecycleService {
  constructor(
    private readonly db: Database,
    private readonly mutations: MutationRegistry,
    private readonly dispatch: AgentDispatchService,
    private readonly connections: AgentConnectionManager,
    private readonly discovery: DiscoveryService,
    private readonly detail: DetailService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async run(
    operation: StackLifecycleKind,
    stackId: string,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<StackOperationOutcome> {
    const stack = await this.operable(stackId);
    const agentId = await this.connectedAgent(stack.hostId);

    const release = this.mutations.acquire(stackKey(stackId), operation);

    try {
      const revisionId = stack.currentRevisionId!;
      const services = await this.deployedServices(stackId, revisionId);

      /*
       * What each service was immediately before, and only for a restart.
       *
       * A restart leaves nothing observable changed except when Docker last
       * started the container, so this is the only thing that can answer
       * afterwards whether it happened — which matters when the reply is lost.
       * Read from the host now rather than from the projection, which may
       * describe a moment that has passed.
       */
      const fingerprint =
        operation === 'restart' ? await this.fingerprintOf(services) : undefined;

      const prepared = await this.prepare({
        stack,
        revisionId,
        operation,
        fingerprint,
        actor,
        context,
      }).catch((error: unknown) => {
        throw claimed(error);
      });

      await this.audit.record({
        action: AUDIT_REQUESTED[operation],
        result: 'success',
        actorUserId: actor.id,
        actorLabel: actor.email,
        targetType: 'stack',
        targetId: stackId,
        targetLabel: stack.name,
        reasonCode: prepared.operationId,
        sourceIp: context.sourceIp,
        userAgent: context.userAgent,
      });

      return await this.dispatchAndSettle({
        operationId: prepared.operationId,
        actionId: prepared.actionId,
        operation,
        stackId,
        stackName: stack.name,
        hostId: stack.hostId,
        revisionId,
        expectedServices: services.map((service) => service.serviceName),
        fingerprint,
        agentId,
        payload: {
          planVersion: LIFECYCLE_PLAN_VERSION,
          stackId,
          revisionId,
          services: services.map((service) => ({
            serviceName: service.serviceName,
            containerId: service.containerId,
            ...(service.dependsOn.length > 0 ? { dependsOn: service.dependsOn } : {}),
          })),
        },
        actor,
        context,
      });
    } finally {
      release();
    }
  }

  /**
   * Asks the host, then decides what the operation did.
   *
   * The reply is a hint. An agent that says it stopped a stack and a host with
   * half of it running disagree about something the host is closer to.
   */
  private async dispatchAndSettle(attempt: DispatchedOperation): Promise<StackOperationOutcome> {
    let failure: AppError | undefined;

    try {
      await this.dispatch.request(attempt.agentId, CAPABILITY[attempt.operation], {
        plan: attempt.payload,
      });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'DOCKER_OPERATION_FAILED';

      if (UNKNOWN_OUTCOME.has(code)) {
        return await this.interrupted(attempt, code);
      }

      failure = error instanceof AppError ? error : undefined;
    }

    const observed = await this.observe(attempt);

    return await this.settle(attempt, observed, failure);
  }

  /**
   * The case where the server cannot say what happened.
   *
   * Nothing is concluded and nothing is dispatched again. The operation stays
   * unresolved, which keeps the stack blocked, and the next complete reading of
   * the host settles it.
   */
  private async interrupted(attempt: DispatchedOperation, code: string): Promise<never> {
    this.logger.warn(
      {
        event: 'stack_operation_outcome_unknown',
        stackId: attempt.stackId,
        hostId: attempt.hostId,
        operationId: attempt.operationId,
        operation: attempt.operation,
        reason: code,
      },
      'a stack operation was dispatched and its outcome is not known',
    );

    await this.db.client
      .update(stackOperations)
      .set({ status: 'interrupted', failureCode: code, updatedAt: new Date() })
      .where(eq(stackOperations.id, attempt.operationId));

    await this.audit.record({
      action: 'stack.operation.interrupted',
      result: 'failure',
      actorUserId: attempt.actor.id,
      actorLabel: attempt.actor.email,
      targetType: 'stack',
      targetId: attempt.stackId,
      targetLabel: attempt.stackName,
      reasonCode: attempt.operationId,
      sourceIp: attempt.context.sourceIp,
      userAgent: attempt.context.userAgent,
    });

    throw new AppError(
      'OPERATION_OUTCOME_UNKNOWN',
      'The request reached the host but its result did not come back. Dockplane will establish what happened from the host and will not repeat the operation; the stack accepts no further operations until then.',
      503,
    );
  }

  /** Reads the host and works out what the services are now. */
  private async observe(attempt: DispatchedOperation) {
    const snapshotComplete = await this.resync(attempt.hostId);
    const observed = await this.observedRuntime(attempt.stackId, attempt.operation === 'restart');

    return {
      snapshotComplete,
      observed,
      outcome: classifyStackLifecycle({
        operation: attempt.operation,
        revisionId: attempt.revisionId,
        expectedServices: attempt.expectedServices,
        observed,
        fingerprint: attempt.fingerprint,
        snapshotComplete,
      }),
    };
  }

  /** Writes what was established. */
  private async settle(
    attempt: DispatchedOperation,
    observed: {
      snapshotComplete: boolean;
      observed: readonly ObservedRuntime[];
      outcome: StackLifecycleOutcome;
    },
    failure: AppError | undefined,
  ): Promise<StackOperationOutcome> {
    const detail = {
      services: observed.observed
        .filter((service) => service.dockerId !== null)
        .map((service) => ({
          serviceName: service.serviceName,
          containerId: service.containerId,
          ...(service.state ? { state: service.state } : {}),
        })),
    };

    this.logger.info(
      {
        event: 'stack_operation_reconciled',
        stackId: attempt.stackId,
        hostId: attempt.hostId,
        operationId: attempt.operationId,
        operation: attempt.operation,
        snapshotComplete: observed.snapshotComplete,
        outcome: observed.outcome.kind,
      },
      'a stack operation was reconciled against the host',
    );

    if (observed.outcome.kind === 'unknown') {
      return await this.interrupted(attempt, 'HOST_NOT_READABLE');
    }

    if (observed.outcome.kind === 'applied') {
      await this.recordApplied(attempt, detail);

      return {
        operationId: attempt.operationId,
        stackId: attempt.stackId,
        operation: attempt.operation,
        status: 'succeeded',
        services: observed.observed
          .filter((service) => service.dockerId !== null)
          .map((service) => ({ serviceName: service.serviceName, state: service.state })),
      };
    }

    if (observed.outcome.kind === 'needs_attention') {
      await this.recordNeedsAttention(attempt, detail, observed.outcome.reason);

      throw new AppError(
        'STACK_LIFECYCLE_PARTIAL',
        'Part of this stack moved and part of it did not. Nothing was undone; it accepts no further operations until somebody applies a revision to it.',
        409,
      );
    }

    await this.recordNotApplied(attempt, detail, failure);

    if (failure?.code === 'STACK_STATE_AMBIGUOUS') {
      throw AppError.conflict(
        'STACK_REPAIR_AMBIGUOUS',
        'The containers of this stack on its host do not add up. Dockplane will not guess which ones it means; resolve it on the host and try again.',
      );
    }

    if (failure?.code === 'STACK_SERVICE_MISSING') {
      throw AppError.conflict(
        'STACK_SERVICE_MISSING',
        'A service of this stack has no container on its host. Deploy a revision to it rather than starting what is not there.',
      );
    }

    throw new AppError(
      FAILED[attempt.operation],
      failure?.message ?? 'The stack was not changed.',
      409,
    );
  }

  /**
   * The operation did what it said.
   *
   * The revision the stack is running is deliberately not touched. A stack that
   * was stopped is still deployed — that is the difference between stopping one
   * and undeploying it — and starting it again does not deploy anything either.
   */
  private async recordApplied(
    attempt: DispatchedOperation,
    detail: OperationDetail,
  ): Promise<void> {
    const now = new Date();

    await this.db.client.transaction(async (tx) => {
      await tx
        .update(stackOperations)
        .set({ status: 'succeeded', detail, resolvedAt: now, updatedAt: now })
        .where(eq(stackOperations.id, attempt.operationId));

      await tx
        .update(stacks)
        .set({ status: RESULT_STATUS[attempt.operation], updatedAt: now })
        .where(eq(stacks.id, attempt.stackId));

      if (attempt.actionId) {
        await tx
          .update(actions)
          .set({ status: 'succeeded', completedAt: now })
          .where(eq(actions.id, attempt.actionId));
      }
    });

    await this.audit.record({
      action: AUDIT_SUCCEEDED[attempt.operation],
      result: 'success',
      actorUserId: attempt.actor.id,
      actorLabel: attempt.actor.email,
      targetType: 'stack',
      targetId: attempt.stackId,
      targetLabel: attempt.stackName,
      reasonCode: attempt.operationId,
      sourceIp: attempt.context.sourceIp,
      userAgent: attempt.context.userAgent,
    });

    await this.events.record({
      hostId: attempt.hostId,
      type: EVENT[attempt.operation],
      resource: `stack:${attempt.stackId}`,
      message: `${attempt.stackName} was ${PAST[attempt.operation]} by ${attempt.actor.email}.`,
      correlationId: attempt.operationId,
    });
  }

  /** Nothing moved. The stack is exactly what it was. */
  private async recordNotApplied(
    attempt: DispatchedOperation,
    detail: OperationDetail,
    failure: AppError | undefined,
  ): Promise<void> {
    const now = new Date();

    await this.db.client.transaction(async (tx) => {
      await tx
        .update(stackOperations)
        .set({
          status: 'failed',
          detail,
          failureCode: failure?.code ?? FAILED[attempt.operation],
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(stackOperations.id, attempt.operationId));

      if (attempt.actionId) {
        await tx
          .update(actions)
          .set({ status: 'failed', completedAt: now, errorCode: failure?.code ?? null })
          .where(eq(actions.id, attempt.actionId));
      }
    });

    await this.audit.record({
      action: AUDIT_FAILED[attempt.operation],
      result: 'failure',
      actorUserId: attempt.actor.id,
      actorLabel: attempt.actor.email,
      targetType: 'stack',
      targetId: attempt.stackId,
      targetLabel: attempt.stackName,
      reasonCode: attempt.operationId,
      sourceIp: attempt.context.sourceIp,
      userAgent: attempt.context.userAgent,
    });

    await this.events.record({
      hostId: attempt.hostId,
      type: 'stack.operation.failed',
      severity: 'warning',
      resource: `stack:${attempt.stackId}`,
      message: `${attempt.stackName} was not ${PAST[attempt.operation]}: the host is as it was.`,
      correlationId: attempt.operationId,
    });
  }

  /**
   * Part of the stack moved and part of it did not.
   *
   * Nothing is started again and nothing is stopped again. The stack says it
   * needs attention, which blocks operations on it and on its containers, and
   * the way out is for somebody to apply a revision — which recreates every
   * service and therefore converges the whole stack on one state.
   */
  private async recordNeedsAttention(
    attempt: DispatchedOperation,
    detail: OperationDetail,
    reason: string,
  ): Promise<void> {
    const now = new Date();

    await this.db.client.transaction(async (tx) => {
      await tx
        .update(stackOperations)
        .set({
          status: 'needs_attention',
          detail,
          failureCode: 'STACK_LIFECYCLE_PARTIAL',
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(stackOperations.id, attempt.operationId));

      await tx
        .update(stacks)
        .set({ status: 'needs_attention', updatedAt: now })
        .where(eq(stacks.id, attempt.stackId));

      if (attempt.actionId) {
        await tx
          .update(actions)
          .set({ status: 'failed', completedAt: now, errorCode: 'STACK_LIFECYCLE_PARTIAL' })
          .where(eq(actions.id, attempt.actionId));
      }
    });

    await this.audit.record({
      action: 'stack.operation.needs_attention',
      result: 'failure',
      actorUserId: attempt.actor.id,
      actorLabel: attempt.actor.email,
      targetType: 'stack',
      targetId: attempt.stackId,
      targetLabel: attempt.stackName,
      reasonCode: attempt.operationId,
      sourceIp: attempt.context.sourceIp,
      userAgent: attempt.context.userAgent,
    });

    await this.events.record({
      hostId: attempt.hostId,
      type: 'stack.operation.failed',
      severity: 'critical',
      resource: `stack:${attempt.stackId}`,
      message: `${attempt.stackName} needs attention: ${reason}.`,
      correlationId: attempt.operationId,
    });
  }

  /** Writes the action and the operation, committed before anything is dispatched. */
  private async prepare(input: {
    stack: StackRow;
    revisionId: string;
    operation: StackLifecycleKind;
    fingerprint: readonly RuntimeFingerprint[] | undefined;
    actor: AuthenticatedUser;
    context: RequestContext;
  }) {
    return await this.db.client.transaction(async (tx) => {
      const [action] = await tx
        .insert(actions)
        .values({
          actorUserId: input.actor.id,
          actorKind: 'user',
          capability: CAPABILITY[input.operation],
          targetType: 'stack',
          targetId: input.stack.id,
          hostId: input.stack.hostId,
          status: 'running',
          requestedAt: new Date(),
          startedAt: new Date(),
          correlationId: input.context.requestId ?? randomUUID(),
        })
        .returning({ id: actions.id });

      const [operation] = await tx
        .insert(stackOperations)
        .values({
          stackId: input.stack.id,
          revisionId: input.revisionId,
          hostId: input.stack.hostId,
          type: input.operation,
          status: 'running',
          actionId: action.id,
          startedBy: input.actor.id,
          fingerprint: input.fingerprint ? { services: [...input.fingerprint] } : null,
        })
        .returning({ id: stackOperations.id });

      return { operationId: operation.id, actionId: action.id };
    });
  }

  /**
   * Everything that has to be true before a stack may be operated on.
   *
   * One place rather than a checklist every caller assembles. The cost of one
   * of these being forgotten is an operation against a stack whose state nobody
   * can describe, which is the situation the whole design exists to avoid.
   */
  private async operable(stackId: string): Promise<StackRow> {
    const [stack] = await this.db.client.select().from(stacks).where(eq(stacks.id, stackId));

    if (!stack) {
      throw AppError.notFound('STACK_NOT_FOUND', 'The stack does not exist.');
    }

    const [host] = await this.db.client
      .select({ id: hosts.id, archivedAt: hosts.archivedAt })
      .from(hosts)
      .where(eq(hosts.id, stack.hostId));

    if (!host) {
      throw AppError.notFound('HOST_NOT_FOUND', 'The host does not exist.');
    }

    assertNotArchived(host, 'its stacks cannot be started, stopped or restarted');

    /*
     * A stack that has never been deployed has no containers to move. Starting
     * one would mean creating them, which is deploying a revision — a different
     * operation with different consequences.
     */
    if (!stack.currentRevisionId) {
      throw AppError.conflict(
        'STACK_NOT_DEPLOYED',
        'This stack has never been deployed, so there is nothing to start or stop. Deploy a revision to it first.',
      );
    }

    /*
     * A stack that needs attention is a host somebody is about to be asked to
     * make sense of, and that decision is made from what is there. Stopping
     * half of it first changes the evidence.
     */
    if (stack.status === 'needs_attention') {
      throw AppError.conflict(
        'STACK_NEEDS_ATTENTION',
        'This stack is neither one revision nor another. Apply a revision to it before starting or stopping it.',
      );
    }

    await this.assertNothingUnresolved(stackId);

    return stack;
  }

  /**
   * Refuses a stack with a mutation that never finished, of either kind.
   *
   * Read from the database rather than from memory, because the case this
   * exists for is a control server that was restarted while something was in
   * flight. Deployments and operations block each other: a restart while a
   * deployment is unresolved would change the state that deployment is about to
   * be judged against, and a deployment while a stop is unresolved would build
   * on a host nobody has established the shape of.
   */
  private async assertNothingUnresolved(stackId: string): Promise<void> {
    const [deployment] = await this.db.client
      .select({ id: stackDeployments.id })
      .from(stackDeployments)
      .where(
        and(
          eq(stackDeployments.stackId, stackId),
          inArray(stackDeployments.status, [...UNRESOLVED_DEPLOYMENT]),
        ),
      );

    if (deployment) {
      throw AppError.conflict(
        'STACK_DEPLOYMENT_CONFLICT',
        'An attempt to apply a revision to this stack has not been resolved yet.',
      );
    }

    const [operation] = await this.db.client
      .select({ id: stackOperations.id })
      .from(stackOperations)
      .where(
        and(
          eq(stackOperations.stackId, stackId),
          inArray(stackOperations.status, [...UNRESOLVED_OPERATION]),
        ),
      );

    if (operation) {
      throw AppError.conflict(
        'STACK_OPERATION_CONFLICT',
        'An operation on this stack has not been resolved yet.',
      );
    }
  }

  /**
   * The services of the deployed revision, with the containers holding them.
   *
   * From the revision's stored summary and the container resources, so nothing
   * here decrypts a Compose file or an environment. A service without a
   * container on the host stops the operation: starting what is not there would
   * mean creating it.
   */
  private async deployedServices(
    stackId: string,
    revisionId: string,
  ): Promise<readonly DeployedService[]> {
    const [revision] = await this.db.client
      .select({ summary: stackRevisions.summary })
      .from(stackRevisions)
      .where(eq(stackRevisions.id, revisionId));

    const expected = revision?.summary ? [...revision.summary.services] : [];

    if (expected.length === 0) {
      throw AppError.conflict(
        'STACK_NOT_DEPLOYED',
        'The deployed revision of this stack describes no services.',
      );
    }

    const rows = await this.db.client
      .select({
        containerId: containers.id,
        dockerId: containers.dockerId,
        serviceName: containers.stackService,
      })
      .from(containers)
      .where(eq(containers.stackId, stackId));

    const held = new Map(
      rows.filter((row) => row.serviceName !== null).map((row) => [row.serviceName!, row]),
    );

    const dependsOn = revision?.summary?.dependsOn ?? {};

    return expected.map((serviceName) => {
      const row = held.get(serviceName);

      if (!row || !row.dockerId) {
        throw AppError.conflict(
          'STACK_SERVICE_MISSING',
          `${serviceName} has no container on this host. Deploy a revision to this stack rather than starting what is not there.`,
        );
      }

      return {
        serviceName,
        containerId: row.containerId,
        dockerId: row.dockerId,
        dependsOn: [...(dependsOn[serviceName] ?? [])],
      };
    });
  }

  /**
   * What each service looks like right now, read from the host.
   *
   * Forced, because the point of it is to be current: a projection written
   * before somebody restarted a container by hand would make a restart that
   * never happened look like one that did.
   */
  private async fingerprintOf(
    services: readonly DeployedService[],
  ): Promise<readonly RuntimeFingerprint[]> {
    const fingerprint: RuntimeFingerprint[] = [];

    for (const service of services) {
      const observed = await this.detail.containerDetail(service.containerId, { force: true });

      fingerprint.push({
        serviceName: service.serviceName,
        containerId: service.containerId,
        dockerId: observed.detail?.dockerId ?? service.dockerId,
        startedAt: observed.detail?.startedAt ?? null,
      });
    }

    return fingerprint;
  }

  /**
   * The stack's services as the host shows them.
   *
   * Start times are read only for a restart, and only then: they cost one
   * inspect per service, and no other operation needs them to say what happened.
   */
  private async observedRuntime(
    stackId: string,
    withStartTimes: boolean,
  ): Promise<readonly ObservedRuntime[]> {
    const rows = await this.db.client
      .select({
        id: containers.id,
        dockerId: containers.dockerId,
        state: containers.state,
        stackService: containers.stackService,
        stackRevisionId: containers.stackRevisionId,
      })
      .from(containers)
      .where(eq(containers.stackId, stackId));

    const observed: ObservedRuntime[] = [];

    for (const row of rows) {
      let startedAt: string | null = null;

      if (withStartTimes && row.dockerId) {
        try {
          const detail = await this.detail.containerDetail(row.id, { force: true });

          startedAt = detail.detail?.startedAt ?? null;
        } catch {
          // Unreadable is not the same as unchanged. The classifier treats a
          // start time it cannot compare as something it cannot conclude from.
          startedAt = null;
        }
      }

      observed.push({
        serviceName: row.stackService ?? '',
        containerId: row.id,
        dockerId: row.dockerId,
        state: row.dockerId ? row.state : null,
        revisionId: row.stackRevisionId,
        startedAt,
      });
    }

    return observed;
  }

  /** Reads the host again, and says whether the answer was complete. */
  private async resync(hostId: string): Promise<boolean> {
    const [agent] = await this.db.client
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.hostId, hostId), isNull(agents.revokedAt)));

    if (!agent) {
      return false;
    }

    try {
      return (await this.discovery.sync(agent.id)).complete;
    } catch (error) {
      this.logger.warn(
        {
          event: 'stack_operation_sync_failed',
          hostId,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'the host could not be read while reconciling a stack operation',
      );

      return false;
    }
  }

  /** The same rule every other host operation uses: performed now, or refused. */
  private async connectedAgent(hostId: string): Promise<string> {
    const [agent] = await this.db.client
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.hostId, hostId), isNull(agents.revokedAt)));

    if (!agent) {
      throw AppError.conflict('AGENT_REVOKED', 'This host has no agent that may be reached.');
    }

    if (!this.connections.isConnected(agent.id)) {
      throw AppError.conflict(
        'AGENT_OFFLINE',
        'The agent is not connected, so the stack cannot be changed now.',
      );
    }

    return agent.id;
  }
}

type StackRow = typeof stacks.$inferSelect;
type OperationDetail = NonNullable<typeof stackOperations.$inferInsert.detail>;

interface DeployedService {
  readonly serviceName: string;
  readonly containerId: string;
  readonly dockerId: string;
  readonly dependsOn: readonly string[];
}

interface DispatchedOperation {
  readonly operationId: string;
  readonly actionId: string | null;
  readonly operation: StackLifecycleKind;
  readonly stackId: string;
  readonly stackName: string;
  readonly hostId: string;
  readonly revisionId: string;
  readonly expectedServices: readonly string[];
  readonly fingerprint: readonly RuntimeFingerprint[] | undefined;
  readonly agentId: string;
  readonly payload: AgentLifecyclePlan;
  readonly actor: AuthenticatedUser;
  readonly context: RequestContext;
}

/** The request shape the agent understands. Identities, never Docker's own. */
interface AgentLifecyclePlan {
  readonly planVersion: number;
  readonly stackId: string;
  readonly revisionId: string;
  readonly services: readonly {
    readonly serviceName: string;
    readonly containerId: string;
    readonly dependsOn?: readonly string[];
  }[];
}

const LIFECYCLE_PLAN_VERSION = 1;

/** The statuses that mean an operation is not over. */
export const UNRESOLVED_OPERATION = ['pending', 'running', 'interrupted'] as const;

const CAPABILITY = {
  start: 'stack.start',
  stop: 'stack.stop',
  restart: 'stack.restart',
} as const;

/** What the stack is once the operation has done what it said. */
const RESULT_STATUS: Record<StackLifecycleKind, string> = {
  start: 'running',
  stop: 'stopped',
  restart: 'running',
};

const FAILED: Record<StackLifecycleKind, ErrorCode> = {
  start: 'STACK_START_FAILED',
  stop: 'STACK_STOP_FAILED',
  restart: 'STACK_RESTART_FAILED',
};

const PAST: Record<StackLifecycleKind, string> = {
  start: 'started',
  stop: 'stopped',
  restart: 'restarted',
};

const EVENT = {
  start: 'stack.started',
  stop: 'stack.stopped',
  restart: 'stack.restarted',
} as const;

const AUDIT_REQUESTED: Record<StackLifecycleKind, AuditAction> = {
  start: 'stack.start.requested',
  stop: 'stack.stop.requested',
  restart: 'stack.restart.requested',
};

const AUDIT_SUCCEEDED: Record<StackLifecycleKind, AuditAction> = {
  start: 'stack.started',
  stop: 'stack.stopped',
  restart: 'stack.restarted',
};

const AUDIT_FAILED: Record<StackLifecycleKind, AuditAction> = {
  start: 'stack.start.failed',
  stop: 'stack.stop.failed',
  restart: 'stack.restart.failed',
};

/**
 * The failures that say nothing about the host.
 *
 * The same set the deployment path uses: a timeout means the server stopped
 * waiting, not that Docker stopped working.
 */
const UNKNOWN_OUTCOME = new Set(['AGENT_REQUEST_TIMEOUT', 'AGENT_NOT_CONNECTED']);

/** Turns a lost race into an answer rather than a constraint violation. */
function claimed(error: unknown): unknown {
  if ((error as { constraint?: string }).constraint === 'stack_operations_unresolved_unique') {
    return AppError.conflict(
      'STACK_OPERATION_CONFLICT',
      'An operation on this stack was started elsewhere and has not been resolved yet.',
    );
  }

  return error;
}
