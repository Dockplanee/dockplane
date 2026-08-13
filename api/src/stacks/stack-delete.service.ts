import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { Logger } from 'pino';

import { AgentDispatchService } from '../agents/agent-dispatch.service';
import { AgentConnectionManager } from '../agents/connection-manager.service';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/authenticated-request';
import { AppError } from '../common/errors';
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
import { DiscoveryService } from '../discovery/discovery.service';
import { EventsService } from '../events/events.service';
import { MutationRegistry } from '../operations/mutation-registry';
import { ObservedClaim, StackDeleteOutcome, classifyStackDelete } from './stack-delete';
import { UNRESOLVED_DEPLOYMENT, stackKey } from './stack-deployment.service';
import { UNRESOLVED_OPERATION } from './stack-lifecycle.service';

/** What the caller is told about a stack that is gone. */
export interface StackDeleteResult {
  readonly stackId: string;
  readonly status: 'deleted';
  /** Volumes Dockplane knows this stack used and did not remove. */
  readonly retainedVolumes: readonly string[];
}

interface RequestContext {
  readonly sourceIp?: string;
  readonly userAgent?: string;
  readonly requestId?: string;
}

/**
 * Deleting a stack.
 *
 * Two things happen, in one order and never the other: the containers go from
 * the host, and then the configuration goes from the database. A stack row
 * removed first would leave containers nobody could identify, and identity is
 * the only thing that makes them removable at all.
 *
 * What deleting a stack is not:
 *
 * It is not deleting data. Named volumes are kept — every one of them, on every
 * path — because a volume holds somebody's database and a stack is a
 * configuration. There is no option here that removes one, which is deliberate:
 * an operator cannot delete their data by ticking the wrong box in a dialog.
 *
 * It is not `docker compose down`. Networks the stack used are left as they are
 * too; Dockplane does not remove them in this version, and a retained network
 * is not a failed deletion.
 *
 * And it is not a repair. A stack that needs attention cannot be deleted: its
 * host does not say clearly which containers are the stack's, and that is
 * exactly the situation in which a destructive operation must not proceed.
 */
@Injectable()
export class StackDeleteService {
  constructor(
    private readonly db: Database,
    private readonly mutations: MutationRegistry,
    private readonly dispatch: AgentDispatchService,
    private readonly connections: AgentConnectionManager,
    private readonly discovery: DiscoveryService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async delete(
    stackId: string,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<StackDeleteResult> {
    const stack = await this.deletable(stackId);
    const release = this.mutations.acquire(stackKey(stackId), 'delete');

    try {
      const retainedVolumes = await this.volumesOf(stack);

      if (!stack.currentRevisionId) {
        return await this.deleteNeverDeployed(stack, retainedVolumes, actor, context);
      }

      const agentId = await this.connectedAgent(stack.hostId);
      const services = await this.deployedServices(stackId, stack.currentRevisionId);

      const prepared = await this.prepare(stack, actor, context).catch((error: unknown) => {
        throw claimed(error);
      });

      await this.audit.record({
        action: 'stack.delete.requested',
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

      return await this.removeThenFinalize({
        operationId: prepared.operationId,
        actionId: prepared.actionId,
        stackId,
        stackName: stack.name,
        hostId: stack.hostId,
        revisionId: stack.currentRevisionId,
        expectedServices: services.map((service) => service.serviceName),
        retainedVolumes,
        agentId,
        payload: {
          planVersion: LIFECYCLE_PLAN_VERSION,
          stackId,
          revisionId: stack.currentRevisionId,
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
   * A stack that never ran, removed without asking a host for anything.
   *
   * Only when the host agrees there is nothing: a stack Dockplane believes was
   * never deployed but whose containers are on the host is a disagreement, and
   * deleting the configuration would leave those containers with no identity
   * anybody could resolve them by.
   */
  private async deleteNeverDeployed(
    stack: StackRow,
    retainedVolumes: readonly string[],
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<StackDeleteResult> {
    const [claimed] = await this.db.client
      .select({ id: containers.id })
      .from(containers)
      .where(and(eq(containers.stackId, stack.id), isNotNull(containers.dockerId)));

    if (claimed) {
      throw AppError.conflict(
        'STACK_STATE_AMBIGUOUS',
        'This stack is not recorded as deployed, but containers on its host claim to belong to it. Dockplane will not delete its configuration while they are there.',
      );
    }

    await this.purge(stack.id, null);

    await this.audit.record({
      action: 'stack.deleted',
      result: 'success',
      actorUserId: actor.id,
      actorLabel: actor.email,
      targetType: 'stack',
      targetId: stack.id,
      targetLabel: stack.name,
      sourceIp: context.sourceIp,
      userAgent: context.userAgent,
    });

    this.logger.info(
      { event: 'stack_deleted', stackId: stack.id, deployed: false },
      'a stack that had never been deployed was deleted',
    );

    return { stackId: stack.id, status: 'deleted', retainedVolumes };
  }

  /** Asks the host to remove the containers, then establishes what happened. */
  private async removeThenFinalize(attempt: DispatchedDelete): Promise<StackDeleteResult> {
    let failure: AppError | undefined;

    try {
      await this.dispatch.request(attempt.agentId, 'stack.remove', { plan: attempt.payload });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'DOCKER_OPERATION_FAILED';

      if (UNKNOWN_OUTCOME.has(code)) {
        return await this.interrupted(attempt, code);
      }

      failure = error instanceof AppError ? error : undefined;
    }

    const snapshotComplete = await this.resync(attempt.hostId);
    const observed = await this.observedClaims(attempt.stackId);

    const outcome = classifyStackDelete({
      expectedServices: attempt.expectedServices,
      observed,
      snapshotComplete,
    });

    this.logger.info(
      {
        event: 'stack_delete_reconciled',
        stackId: attempt.stackId,
        hostId: attempt.hostId,
        operationId: attempt.operationId,
        snapshotComplete,
        outcome: outcome.kind,
      },
      'a stack removal was reconciled against the host',
    );

    return await this.settle(attempt, outcome, failure);
  }

  private async settle(
    attempt: DispatchedDelete,
    outcome: StackDeleteOutcome,
    failure: AppError | undefined,
  ): Promise<StackDeleteResult> {
    if (outcome.kind === 'unknown') {
      return await this.interrupted(attempt, 'HOST_NOT_READABLE');
    }

    if (outcome.kind === 'finalize_deleted') {
      await this.purge(attempt.stackId, attempt.actionId);

      await this.audit.record({
        action: 'stack.deleted',
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
        type: 'stack.deleted',
        resource: `stack:${attempt.stackId}`,
        message: `${attempt.stackName} was deleted by ${attempt.actor.email}. Its volumes were kept.`,
        correlationId: attempt.operationId,
      });

      this.logger.info(
        { event: 'stack_deleted', stackId: attempt.stackId, deployed: true },
        'a deployed stack was removed from its host and deleted',
      );

      return {
        stackId: attempt.stackId,
        status: 'deleted',
        retainedVolumes: attempt.retainedVolumes,
      };
    }

    if (outcome.kind === 'needs_attention') {
      await this.recordNeedsAttention(attempt, outcome.reason);

      throw new AppError(
        'STACK_DELETE_PARTIAL',
        'Part of this stack was removed and part of it was not. Nothing was rebuilt and nothing was deleted from Dockplane; apply a revision to it before deleting it again.',
        409,
      );
    }

    await this.recordNotApplied(attempt, failure);

    if (failure?.code === 'STACK_STATE_AMBIGUOUS') {
      throw AppError.conflict(
        'STACK_REPAIR_AMBIGUOUS',
        'The containers of this stack on its host do not add up. Dockplane will not guess which ones it means; resolve it on the host and try again.',
      );
    }

    throw new AppError(
      'STACK_DELETE_FAILED',
      failure?.message ?? 'The stack was not removed from its host, so nothing was deleted.',
      409,
    );
  }

  /**
   * The case where the server cannot say what happened.
   *
   * Nothing is concluded, nothing is dispatched again and nothing is deleted:
   * the containers may be gone, and the configuration is what identifies them
   * if they are not. The next complete reading of the host settles it.
   */
  private async interrupted(attempt: DispatchedDelete, code: string): Promise<never> {
    this.logger.warn(
      {
        event: 'stack_delete_outcome_unknown',
        stackId: attempt.stackId,
        hostId: attempt.hostId,
        operationId: attempt.operationId,
        reason: code,
      },
      'a stack removal was dispatched and its outcome is not known',
    );

    await this.db.client
      .update(stackOperations)
      .set({ status: 'interrupted', failureCode: code, updatedAt: new Date() })
      .where(eq(stackOperations.id, attempt.operationId));

    await this.audit.record({
      action: 'stack.delete.interrupted',
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
      'The request reached the host but its result did not come back. Dockplane will establish what happened from the host and will not repeat the operation; nothing has been deleted.',
      503,
    );
  }

  /** The removal did not take. The stack is exactly what it was. */
  private async recordNotApplied(
    attempt: DispatchedDelete,
    failure: AppError | undefined,
  ): Promise<void> {
    const now = new Date();

    await this.db.client.transaction(async (tx) => {
      await tx
        .update(stackOperations)
        .set({
          status: 'failed',
          failureCode: failure?.code ?? 'STACK_DELETE_FAILED',
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
      action: 'stack.delete.failed',
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
  }

  /**
   * Some containers are gone and some are not.
   *
   * The configuration stays. It is the only thing that says what those
   * containers were, which is what somebody resolving this will work from.
   */
  private async recordNeedsAttention(attempt: DispatchedDelete, reason: string): Promise<void> {
    const now = new Date();

    await this.db.client.transaction(async (tx) => {
      await tx
        .update(stackOperations)
        .set({
          status: 'needs_attention',
          failureCode: 'STACK_DELETE_PARTIAL',
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
          .set({ status: 'failed', completedAt: now, errorCode: 'STACK_DELETE_PARTIAL' })
          .where(eq(actions.id, attempt.actionId));
      }
    });

    await this.audit.record({
      action: 'stack.delete.needs_attention',
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

  /**
   * Removes everything Dockplane holds about the stack, once its host is clear.
   *
   * A hard delete. The revisions, their environments and the encrypted Compose
   * source go with the stack row through the schema's own cascades, and the
   * container resources are removed here because they are keyed to the stack by
   * identity rather than by a constraint.
   *
   * Nothing is kept as a tombstone. The audit trail records the deletion
   * against the stack's identifier and name, which are not sensitive and need
   * no row to point at; keeping an encrypted Compose source alive to satisfy a
   * foreign key would be keeping somebody's credentials for bookkeeping.
   */
  private async purge(stackId: string, actionId: string | null): Promise<void> {
    const now = new Date();

    await this.db.client.transaction(async (tx) => {
      if (actionId) {
        await tx
          .update(actions)
          .set({ status: 'succeeded', completedAt: now })
          .where(eq(actions.id, actionId));
      }

      await tx.delete(containers).where(eq(containers.stackId, stackId));
      await tx.delete(stacks).where(eq(stacks.id, stackId));
    });
  }

  /** Writes the action and the operation, committed before anything is dispatched. */
  private async prepare(stack: StackRow, actor: AuthenticatedUser, context: RequestContext) {
    return await this.db.client.transaction(async (tx) => {
      const [action] = await tx
        .insert(actions)
        .values({
          actorUserId: actor.id,
          actorKind: 'user',
          capability: 'stack.remove',
          targetType: 'stack',
          targetId: stack.id,
          hostId: stack.hostId,
          status: 'running',
          requestedAt: new Date(),
          startedAt: new Date(),
          correlationId: context.requestId ?? randomUUID(),
        })
        .returning({ id: actions.id });

      const [operation] = await tx
        .insert(stackOperations)
        .values({
          stackId: stack.id,
          revisionId: stack.currentRevisionId!,
          hostId: stack.hostId,
          type: 'delete',
          status: 'running',
          actionId: action.id,
          startedBy: actor.id,
        })
        .returning({ id: stackOperations.id });

      return { operationId: operation.id, actionId: action.id };
    });
  }

  /** Everything that has to be true before a stack may be deleted. */
  private async deletable(stackId: string): Promise<StackRow> {
    const [stack] = await this.db.client.select().from(stacks).where(eq(stacks.id, stackId));

    if (!stack) {
      throw AppError.notFound('STACK_NOT_FOUND', 'The stack does not exist.');
    }

    const [host] = await this.db.client
      .select({ id: hosts.id })
      .from(hosts)
      .where(eq(hosts.id, stack.hostId));

    if (!host) {
      throw AppError.notFound('HOST_NOT_FOUND', 'The host does not exist.');
    }

    /*
     * A stack that needs attention is one whose host does not say clearly which
     * containers are its own. That is the state in which a removal could take
     * away something that is not ours, so it is refused rather than forced.
     * There is deliberately no way to override this.
     */
    if (stack.status === 'needs_attention') {
      throw AppError.conflict(
        'STACK_NEEDS_ATTENTION',
        'This stack is neither one revision nor another. Apply a revision to it before deleting it.',
      );
    }

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

    return stack;
  }

  /**
   * The services of the deployed revision, with the containers holding them.
   *
   * From the revision's summary and the container resources, so deleting a
   * stack decrypts nothing: not its Compose source, not its environment, not a
   * single secret. A stack whose configuration can no longer be read is still
   * one an operator can remove.
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
          `${serviceName} has no container on this host, so Dockplane cannot say what removing this stack would remove. Apply a revision to it first.`,
        );
      }

      return {
        serviceName,
        containerId: row.containerId,
        dependsOn: [...(dependsOn[serviceName] ?? [])],
      };
    });
  }

  /** The named volumes this stack's revisions describe, which are all kept. */
  private async volumesOf(stack: StackRow): Promise<readonly string[]> {
    const revisionId = stack.currentRevisionId ?? stack.latestRevisionId;

    if (!revisionId) {
      return [];
    }

    const [revision] = await this.db.client
      .select({ summary: stackRevisions.summary })
      .from(stackRevisions)
      .where(eq(stackRevisions.id, revisionId));

    return revision?.summary ? [...revision.summary.volumes] : [];
  }

  /** What the host still shows for this stack. */
  private async observedClaims(stackId: string): Promise<readonly ObservedClaim[]> {
    const rows = await this.db.client
      .select({
        id: containers.id,
        dockerId: containers.dockerId,
        stackService: containers.stackService,
      })
      .from(containers)
      .where(eq(containers.stackId, stackId));

    return rows.map((row) => ({
      serviceName: row.stackService ?? '',
      containerId: row.id,
      dockerId: row.dockerId,
    }));
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
          event: 'stack_delete_sync_failed',
          hostId,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'the host could not be read while reconciling a stack removal',
      );

      return false;
    }
  }

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
        'The agent is not connected, so this stack cannot be removed from its host now.',
      );
    }

    return agent.id;
  }
}

type StackRow = typeof stacks.$inferSelect;

interface DeployedService {
  readonly serviceName: string;
  readonly containerId: string;
  readonly dependsOn: readonly string[];
}

interface DispatchedDelete {
  readonly operationId: string;
  readonly actionId: string | null;
  readonly stackId: string;
  readonly stackName: string;
  readonly hostId: string;
  readonly revisionId: string;
  readonly expectedServices: readonly string[];
  readonly retainedVolumes: readonly string[];
  readonly agentId: string;
  readonly payload: {
    readonly planVersion: number;
    readonly stackId: string;
    readonly revisionId: string;
    readonly services: readonly {
      readonly serviceName: string;
      readonly containerId: string;
      readonly dependsOn?: readonly string[];
    }[];
  };
  readonly actor: AuthenticatedUser;
  readonly context: RequestContext;
}

const LIFECYCLE_PLAN_VERSION = 1;

/** The failures that say nothing about the host. */
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
