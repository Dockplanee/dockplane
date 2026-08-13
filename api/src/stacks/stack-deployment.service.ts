import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { Logger } from 'pino';

import { AgentDispatchService } from '../agents/agent-dispatch.service';
import { AgentConnectionManager } from '../agents/connection-manager.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/authenticated-request';
import { SecretBox } from '../common/crypto';
import { AppError } from '../common/errors';
import { LOGGER, SECRET_BOX } from '../config/tokens';
import { Database } from '../database/database';
import {
  actions,
  agents,
  containers,
  hosts,
  stackDeployments,
  stackOperations,
  stackRevisionEnvironment,
  stackRevisions,
  stacks,
} from '../database/schema';
import { DiscoveryService } from '../discovery/discovery.service';
import { EventsService } from '../events/events.service';
import { MutationRegistry } from '../operations/mutation-registry';
import { ComposeCompilerService, StackDeploymentPlan } from './compose-compiler.service';
import { ObservedService, StackApplyOutcome, classifyStackApply } from './stack-deployment';
import { UNRESOLVED_OPERATION } from './stack-lifecycle.service';
import { AgentStackPlan, agentPlanFor, containerNames } from './stack-plan';

/** What the caller is told about an attempt that succeeded. */
export interface DeploymentOutcome {
  readonly deploymentId: string;
  readonly stackId: string;
  readonly revisionId: string;
  readonly kind: ApplyKind;
  readonly status: 'succeeded';
  readonly services: readonly { serviceName: string; state: string | null }[];
}

/** Why a revision is being applied. All four do the same thing. */
export type ApplyKind = 'initial' | 'redeploy' | 'rollback' | 'repair';

interface RequestContext {
  readonly sourceIp?: string;
  readonly userAgent?: string;
  readonly requestId?: string;
}

/**
 * Applying a revision of a stack to its host.
 *
 * Deploying a stack for the first time, moving it to a newer revision, putting
 * it back to an older one and converging one that was left half-applied are the
 * same operation: make this revision the thing running. They differ in what the
 * host already holds, which is read rather than assumed, and in the word an
 * operator sees in the history afterwards.
 *
 * The shape is the container management service's, for the same reasons. What
 * is intended is written and committed before an agent is asked for anything,
 * the agent is asked outside any transaction, and what actually happened is
 * established by reading the host rather than by believing the reply.
 *
 * Four rules run through the rest.
 *
 * The revision is compiled again, every time, from the source and environment
 * that were stored. No plan is persisted — a plan carries resolved values,
 * secrets included — so a rollback compiles the old revision afresh, and one
 * that no longer compiles is refused before the host is touched.
 *
 * `currentRevisionId` is what was confirmed, not what was asked for. It changes
 * only when the target has been read back off the host, and it stays where it
 * is when an attempt fails.
 *
 * `latestRevisionId` is never changed here. Deploying an older revision does
 * not rewrite what was saved: the history stays honest, and the stack simply
 * reports that what is running is not the newest thing saved.
 *
 * Nothing is removed to tidy up. A host that ends up neither one revision nor
 * the other needs a person, and the containers on it may already have written
 * to a volume.
 */
@Injectable()
export class StackDeploymentService {
  constructor(
    private readonly db: Database,
    private readonly mutations: MutationRegistry,
    private readonly compiler: ComposeCompilerService,
    private readonly dispatch: AgentDispatchService,
    private readonly connections: AgentConnectionManager,
    private readonly discovery: DiscoveryService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Applies a revision of a stack.
   *
   * Any revision the stack has, not only its newest: going back to an older one
   * is the whole of what a rollback is. What is refused is applying the
   * revision that is already running to a stack that is running it happily —
   * there would be nothing to do, and recreating every container to achieve
   * nothing is not a no-op.
   */
  async deploy(
    stackId: string,
    revisionId: string,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<DeploymentOutcome> {
    const stack = await this.find(stackId);
    const target = await this.revision(stackId, revisionId);
    const from = stack.currentRevisionId
      ? await this.revision(stackId, stack.currentRevisionId)
      : null;

    const kind = kindOf(stack, target, from);

    if (kind === null) {
      throw AppError.conflict(
        'STACK_REVISION_ALREADY_DEPLOYED',
        'This stack is already running that revision.',
      );
    }

    const agentId = await this.connectedAgent(stack.hostId);

    /*
     * Two guards, answering different questions.
     *
     * The lock answers "is an attempt running right now"; the unresolved
     * attempt in the database answers "did one never finish". A restart clears
     * the first and leaves the second exactly as it was, which is the case that
     * matters: the containers a half-finished attempt created are still on the
     * host.
     *
     * A stack that needs attention is not blocked here. Applying a revision to
     * it deliberately is the only way out, and that is this call.
     */
    await this.assertNoUnresolvedDeployment(stackId);

    const release = this.mutations.acquire(stackKey(stackId), 'deploy');

    try {
      const plan = await this.compile(stack.name, target);
      const names = containerNames(plan);

      const existing = await this.stackContainers(stackId);

      await this.assertNamesAreFree(stack.hostId, names, existing);

      const prepared = await this.prepare({
        stack,
        target,
        from,
        kind,
        plan,
        names,
        existing,
        actor,
        context,
      }).catch((error: unknown) => {
        throw claimed(error);
      });

      await this.audit.record({
        action: AUDIT_REQUESTED[kind],
        result: 'success',
        actorUserId: actor.id,
        actorLabel: actor.email,
        targetType: 'stack',
        targetId: stackId,
        targetLabel: stack.name,
        reasonCode: prepared.deploymentId,
        sourceIp: context.sourceIp,
        userAgent: context.userAgent,
      });

      return await this.run({
        deploymentId: prepared.deploymentId,
        actionId: prepared.actionId,
        kind,
        stackId,
        stackName: stack.name,
        hostId: stack.hostId,
        revisionId,
        fromRevisionId: from?.id ?? null,
        targetServices: plan.services.map((service) => service.serviceName),
        fromServices: summaryServices(from),
        agentId,
        containers: prepared.containers,
        payload: agentPlanFor({
          stackId,
          revisionId,
          plan,
          containers: prepared.containers,
          // The volumes the stack was already using. An absent one of those is
          // a volume that has gone, not a volume this revision introduces.
          existingVolumes: summaryVolumes(from),
        }),
        actor,
        context,
      });
    } finally {
      release();
    }
  }

  /**
   * Dispatches, then establishes what happened.
   *
   * The reply is not what decides the outcome. An agent that says it put the
   * host back and a host showing half of each revision disagree about something
   * the host is closer to.
   */
  private async run(attempt: DispatchedApply): Promise<DeploymentOutcome> {
    let failure: AppError | undefined;

    try {
      await this.dispatch.request(attempt.agentId, 'stack.deploy', { plan: attempt.payload });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'DOCKER_OPERATION_FAILED';

      if (UNKNOWN_OUTCOME.has(code)) {
        return await this.interrupted(attempt, code);
      }

      /*
       * A refusal the agent was able to state. Docker may still have been
       * changed — an attempt that failed on its third service created two
       * containers first — so the host is read before anything is concluded,
       * exactly as it is after a success.
       */
      failure = error instanceof AppError ? error : undefined;
    }

    const observed = await this.observe(attempt);

    return await this.settle(attempt, observed, failure);
  }

  /**
   * The case where the server cannot say what happened.
   *
   * Nothing is concluded and nothing is dispatched again. The attempt stays
   * unresolved, which keeps the stack blocked, and the next complete discovery
   * of that host settles it.
   */
  private async interrupted(attempt: DispatchedApply, code: string): Promise<never> {
    this.logger.warn(
      {
        event: 'stack_apply_outcome_unknown',
        stackId: attempt.stackId,
        hostId: attempt.hostId,
        deploymentId: attempt.deploymentId,
        reason: code,
      },
      'a stack revision was dispatched and its outcome is not known',
    );

    await this.db.client
      .update(stackDeployments)
      .set({ status: 'interrupted', failureCode: code, updatedAt: new Date() })
      .where(eq(stackDeployments.id, attempt.deploymentId));

    await this.audit.record({
      action: 'stack.deploy.interrupted',
      result: 'failure',
      actorUserId: attempt.actor.id,
      actorLabel: attempt.actor.email,
      targetType: 'stack',
      targetId: attempt.stackId,
      targetLabel: attempt.stackName,
      reasonCode: attempt.deploymentId,
      sourceIp: attempt.context.sourceIp,
      userAgent: attempt.context.userAgent,
    });

    throw new AppError(
      'OPERATION_OUTCOME_UNKNOWN',
      'The request reached the host but its result did not come back. Dockplane will establish what happened from the host and will not repeat the operation; the stack accepts no further deployments until then.',
      503,
    );
  }

  /** Reads the host and compares it with the two states that were established. */
  private async observe(attempt: DispatchedApply) {
    const snapshotComplete = await this.resync(attempt.hostId);
    const rows = await this.stackContainers(attempt.stackId);

    const observed: ObservedService[] = rows.map((row) => ({
      serviceName: row.stackService ?? '',
      containerId: row.id,
      dockerId: row.dockerId,
      state: row.dockerId ? row.state : null,
      revisionId: row.stackRevisionId,
    }));

    return {
      snapshotComplete,
      observed,
      outcome: classifyStackApply({
        fromRevisionId: attempt.fromRevisionId,
        targetRevisionId: attempt.revisionId,
        targetServices: attempt.targetServices,
        fromServices: attempt.fromServices,
        observed,
        snapshotComplete,
      }),
    };
  }

  /** Writes what was established, and only then calls the revision applied. */
  private async settle(
    attempt: DispatchedApply,
    observed: {
      snapshotComplete: boolean;
      observed: readonly ObservedService[];
      outcome: StackApplyOutcome;
    },
    failure: AppError | undefined,
  ): Promise<DeploymentOutcome> {
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
        event: 'stack_apply_reconciled',
        stackId: attempt.stackId,
        hostId: attempt.hostId,
        deploymentId: attempt.deploymentId,
        kind: attempt.kind,
        snapshotComplete: observed.snapshotComplete,
        outcome: observed.outcome.kind,
      },
      'a stack revision was reconciled against the host',
    );

    if (observed.outcome.kind === 'unknown') {
      /*
       * The host could not be read well enough to say. Treated exactly like a
       * dispatch whose answer never came: the attempt stays unresolved and
       * nothing is repeated.
       */
      return await this.interrupted(attempt, 'HOST_NOT_READABLE');
    }

    if (observed.outcome.kind === 'finalize_target') {
      await this.recordApplied(attempt, detail);

      return {
        deploymentId: attempt.deploymentId,
        stackId: attempt.stackId,
        revisionId: attempt.revisionId,
        kind: attempt.kind,
        status: 'succeeded',
        services: observed.observed
          .filter((service) => service.dockerId !== null)
          .map((service) => ({ serviceName: service.serviceName, state: service.state })),
      };
    }

    if (observed.outcome.kind === 'needs_attention') {
      await this.recordNeedsAttention(attempt, detail, observed.outcome.reason);

      throw new AppError(
        'STACK_DEPLOYMENT_PARTIAL',
        'This stack is now neither the revision it was nor the one it was going to. Nothing was removed; it accepts no container operations until somebody applies a revision to it.',
        409,
      );
    }

    // The host is as it was: either the attempt never took, or the agent put it
    // back. Both are the same thing to the stack, which has not changed.
    await this.recordNotApplied(attempt, detail, failure);

    /*
     * The host said its own containers do not add up — two of them claiming one
     * service. Reported as what it means for the operator rather than as what
     * the agent called it: nothing can be applied to this stack until somebody
     * decides which container is the real one.
     */
    if (failure?.code === 'STACK_STATE_AMBIGUOUS') {
      throw AppError.conflict(
        'STACK_REPAIR_AMBIGUOUS',
        'More than one container on this host claims to be the same service of this stack. Dockplane will not choose between them; resolve it on the host and try again.',
      );
    }

    throw new AppError(
      failure?.code ?? 'STACK_APPLY_FAILED',
      failure?.message ??
        (attempt.fromRevisionId
          ? 'The revision was not applied. The stack is as it was.'
          : 'The stack was not deployed. The host is as it was.'),
      409,
    );
  }

  /** The only place a stack's confirmed revision changes. */
  private async recordApplied(attempt: DispatchedApply, detail: DeploymentDetail): Promise<void> {
    const now = new Date();

    await this.db.client.transaction(async (tx) => {
      await tx
        .update(stackDeployments)
        .set({ status: 'succeeded', detail, resolvedAt: now, updatedAt: now })
        .where(eq(stackDeployments.id, attempt.deploymentId));

      /*
       * Set from what was confirmed, and compared against what the stack was.
       * Another pass may have settled this attempt first, and writing over that
       * would record the older of two answers.
       *
       * `latestRevisionId` is deliberately untouched: applying an older
       * revision does not un-save the newer ones.
       */
      await tx
        .update(stacks)
        .set({
          currentRevisionId: attempt.revisionId,
          desiredRevisionId: null,
          status: 'running',
          lastDeployedAt: now,
          updatedAt: now,
        })
        .where(eq(stacks.id, attempt.stackId));

      /*
       * Services this revision no longer has. Their containers are gone from
       * the host — that is what "exactly the target" means — so the resources
       * that named them go too. A service added again later is a new resource,
       * which is the honest answer: nothing connects the two.
       */
      await tx.delete(containers).where(orphanedServices(attempt));

      if (attempt.actionId) {
        await tx
          .update(actions)
          .set({ status: 'succeeded', completedAt: now })
          .where(eq(actions.id, attempt.actionId));
      }
    });

    await this.audit.record({
      action: AUDIT_SUCCEEDED[attempt.kind],
      result: 'success',
      actorUserId: attempt.actor.id,
      actorLabel: attempt.actor.email,
      targetType: 'stack',
      targetId: attempt.stackId,
      targetLabel: attempt.stackName,
      reasonCode: attempt.deploymentId,
      sourceIp: attempt.context.sourceIp,
      userAgent: attempt.context.userAgent,
    });

    await this.events.record({
      hostId: attempt.hostId,
      type: 'stack.deployed',
      resource: `stack:${attempt.stackId}`,
      message: `${attempt.stackName} is running the revision ${attempt.actor.email} applied.`,
      correlationId: attempt.deploymentId,
    });
  }

  /**
   * The attempt did not take and the host is as it was.
   *
   * Either nothing was built, or the agent put back what it moved. The stack is
   * what it was before, so nothing about it changes — only the record of the
   * attempt, and the resources that were allocated for services this stack does
   * not have.
   */
  private async recordNotApplied(
    attempt: DispatchedApply,
    detail: DeploymentDetail,
    failure: AppError | undefined,
  ): Promise<void> {
    const now = new Date();

    await this.db.client.transaction(async (tx) => {
      await tx
        .update(stackDeployments)
        .set({
          status: attempt.fromRevisionId ? 'rolled_back' : 'failed',
          detail,
          failureCode: failure?.code ?? 'STACK_APPLY_FAILED',
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(stackDeployments.id, attempt.deploymentId));

      await tx
        .update(stacks)
        .set({
          status: attempt.fromRevisionId ? 'running' : 'not_deployed',
          desiredRevisionId: null,
          updatedAt: now,
        })
        .where(eq(stacks.id, attempt.stackId));

      // Resources allocated for this attempt that no container claims. Only
      // ever removed when the host was read completely and showed none.
      await tx.delete(containers).where(unclaimed(attempt.stackId));

      if (attempt.actionId) {
        await tx
          .update(actions)
          .set({ status: 'failed', completedAt: now, errorCode: failure?.code ?? null })
          .where(eq(actions.id, attempt.actionId));
      }
    });

    await this.audit.record({
      action: attempt.fromRevisionId ? 'stack.apply.rolled_back' : 'stack.deploy.failed',
      result: 'failure',
      actorUserId: attempt.actor.id,
      actorLabel: attempt.actor.email,
      targetType: 'stack',
      targetId: attempt.stackId,
      targetLabel: attempt.stackName,
      reasonCode: attempt.deploymentId,
      sourceIp: attempt.context.sourceIp,
      userAgent: attempt.context.userAgent,
    });

    await this.events.record({
      hostId: attempt.hostId,
      type: 'stack.deployment.failed',
      severity: 'warning',
      resource: `stack:${attempt.stackId}`,
      message: `${attempt.stackName} was not changed: the revision did not come up.`,
      correlationId: attempt.deploymentId,
    });
  }

  /**
   * The host is neither one revision nor the other.
   *
   * Nothing is removed — not the containers that started, not the volumes they
   * may already have written to, and not the resources that name what was
   * expected. The stack says it needs attention, which blocks container
   * operations on it, and the way out is for somebody to apply a revision.
   */
  private async recordNeedsAttention(
    attempt: DispatchedApply,
    detail: DeploymentDetail,
    reason: string,
  ): Promise<void> {
    const now = new Date();

    await this.db.client.transaction(async (tx) => {
      await tx
        .update(stackDeployments)
        .set({
          status: 'needs_attention',
          detail,
          failureCode: 'STACK_DEPLOYMENT_PARTIAL',
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(stackDeployments.id, attempt.deploymentId));

      await tx
        .update(stacks)
        .set({ status: 'needs_attention', desiredRevisionId: null, updatedAt: now })
        .where(eq(stacks.id, attempt.stackId));

      if (attempt.actionId) {
        await tx
          .update(actions)
          .set({ status: 'failed', completedAt: now, errorCode: 'STACK_DEPLOYMENT_PARTIAL' })
          .where(eq(actions.id, attempt.actionId));
      }
    });

    await this.audit.record({
      action: 'stack.deploy.needs_attention',
      result: 'failure',
      actorUserId: attempt.actor.id,
      actorLabel: attempt.actor.email,
      targetType: 'stack',
      targetId: attempt.stackId,
      targetLabel: attempt.stackName,
      reasonCode: attempt.deploymentId,
      sourceIp: attempt.context.sourceIp,
      userAgent: attempt.context.userAgent,
    });

    await this.events.record({
      hostId: attempt.hostId,
      type: 'stack.deployment.failed',
      severity: 'critical',
      resource: `stack:${attempt.stackId}`,
      message: `${attempt.stackName} needs attention: ${reason}.`,
      correlationId: attempt.deploymentId,
    });
  }

  /**
   * Writes the attempt, the action and the container resource of every service.
   *
   * Short, and committed before anything is dispatched. A service the stack
   * already has keeps its resource — that is what makes an operator's container
   * the same thing across revisions — and a service this revision introduces
   * gets a new one. A service that is being removed keeps its row until the
   * target is confirmed, because until then it is the way back.
   */
  private async prepare(input: {
    stack: StackRow;
    target: RevisionRow;
    from: RevisionRow | null;
    kind: ApplyKind;
    plan: StackDeploymentPlan;
    names: Map<string, string>;
    existing: readonly ContainerRow[];
    actor: AuthenticatedUser;
    context: RequestContext;
  }) {
    const held = new Map(
      input.existing
        .filter((row) => row.stackService !== null)
        .map((row) => [row.stackService!, row]),
    );

    return await this.db.client.transaction(async (tx) => {
      const [action] = await tx
        .insert(actions)
        .values({
          actorUserId: input.actor.id,
          actorKind: 'user',
          capability: 'stack.deploy',
          targetType: 'stack',
          targetId: input.stack.id,
          hostId: input.stack.hostId,
          status: 'running',
          requestedAt: new Date(),
          startedAt: new Date(),
          correlationId: input.context.requestId ?? randomUUID(),
        })
        .returning({ id: actions.id });

      const [deployment] = await tx
        .insert(stackDeployments)
        .values({
          stackId: input.stack.id,
          revisionId: input.target.id,
          fromRevisionId: input.from?.id ?? null,
          hostId: input.stack.hostId,
          kind: input.kind,
          status: 'running',
          actionId: action.id,
          startedBy: input.actor.id,
        })
        .returning({ id: stackDeployments.id });

      const allocated = new Map<string, string>();

      for (const service of input.plan.services) {
        const existing = held.get(service.serviceName);

        if (existing) {
          allocated.set(service.serviceName, existing.id);
          continue;
        }

        const [container] = await tx
          .insert(containers)
          .values({
            hostId: input.stack.hostId,
            dockerId: null,
            name: input.names.get(service.serviceName)!,
            image: service.image,
            state: 'creating',
            stackId: input.stack.id,
            stackService: service.serviceName,
            observedAt: new Date(),
          })
          .returning({ id: containers.id });

        allocated.set(service.serviceName, container.id);
      }

      await tx
        .update(stacks)
        .set({
          desiredRevisionId: input.target.id,
          status: 'deploying',
          updatedAt: new Date(),
        })
        .where(eq(stacks.id, input.stack.id));

      return { deploymentId: deployment.id, actionId: action.id, containers: allocated };
    });
  }

  /**
   * Compiles the stored revision again.
   *
   * Never a plan read back from the database, because none is stored: a plan
   * carries resolved values including secrets. Compiling here also means a
   * revision that has become undeployable — including an older one somebody is
   * rolling back to — is refused before anything is touched, rather than
   * failing on the host.
   */
  private async compile(projectName: string, revision: RevisionRow) {
    const environment = await this.db.client
      .select()
      .from(stackRevisionEnvironment)
      .where(eq(stackRevisionEnvironment.revisionId, revision.id));

    const result = await this.compiler.compile({
      projectName,
      compose: this.box.decrypt(revision.composeSourceEncrypted),
      // The values exist for this call. They are not stored, logged, audited or
      // returned, and the plan they end up in is not persisted either.
      environment: Object.fromEntries(
        environment.map((variable) => [
          variable.key,
          variable.isSecret ? this.box.decrypt(variable.valueEncrypted!) : (variable.value ?? ''),
        ]),
      ),
    });

    if (!result.ok) {
      throw new AppError(
        'STACK_CONFIGURATION_INVALID',
        'This revision is not one Dockplane can deploy.',
        409,
        result.problems,
      );
    }

    return result.plan;
  }

  /** Every container this stack is on record as having. */
  private async stackContainers(stackId: string) {
    return await this.db.client
      .select({
        id: containers.id,
        dockerId: containers.dockerId,
        name: containers.name,
        state: containers.state,
        stackService: containers.stackService,
        stackRevisionId: containers.stackRevisionId,
      })
      .from(containers)
      .where(eq(containers.stackId, stackId));
  }

  /**
   * Refuses a revision whose containers would collide with something.
   *
   * This stack's own containers are not a collision: they are what is being
   * replaced, and the agent moves them aside before the new ones are created.
   * The agent checks the host again, where the answer is authoritative and
   * where volumes and networks are checked too; this exists so an operator is
   * told what is in the way before an attempt is written down.
   */
  private async assertNamesAreFree(
    hostId: string,
    names: ReadonlyMap<string, string>,
    existing: readonly ContainerRow[],
  ) {
    const ours = new Set(existing.map((row) => row.id));

    const found = await this.db.client
      .select({ id: containers.id, name: containers.name, dockerId: containers.dockerId })
      .from(containers)
      .where(eq(containers.hostId, hostId));

    const taken = new Map(
      found.filter((row) => !ours.has(row.id)).map((row) => [row.name.toLowerCase(), row]),
    );

    for (const name of names.values()) {
      const collision = taken.get(name.toLowerCase());

      if (collision) {
        throw AppError.conflict(
          'RESOURCE_NAME_CONFLICT',
          collision.dockerId
            ? `A container called ${name} already exists on this host and is not this stack's.`
            : `A container called ${name} is already being created on this host.`,
        );
      }
    }
  }

  /**
   * Refuses a stack whose last attempt never resolved.
   *
   * Read from the database rather than from memory, because the case this
   * exists for is a control server that was restarted while an attempt was in
   * flight. The database refuses a second unresolved attempt as well; this is
   * here so the caller is told what is happening rather than shown a constraint
   * violation.
   */
  private async assertNoUnresolvedDeployment(stackId: string): Promise<void> {
    const [unresolved] = await this.db.client
      .select({ id: stackDeployments.id })
      .from(stackDeployments)
      .where(
        and(
          eq(stackDeployments.stackId, stackId),
          inArray(stackDeployments.status, [...UNRESOLVED_DEPLOYMENT]),
        ),
      );

    if (unresolved) {
      throw AppError.conflict(
        'STACK_DEPLOYMENT_CONFLICT',
        'An attempt to apply a revision to this stack has not been resolved yet.',
      );
    }

    /*
     * And an operation that never finished, which is the other half of the same
     * rule. A stop whose outcome nobody established leaves a host that a
     * deployment would then be judged against.
     *
     * Two tables, because they are two different things — no revision is
     * applied by a restart — and one guard, because a stack has one state and
     * only one thing may be changing it.
     */
    const [operating] = await this.db.client
      .select({ id: stackOperations.id })
      .from(stackOperations)
      .where(
        and(
          eq(stackOperations.stackId, stackId),
          inArray(stackOperations.status, [...UNRESOLVED_OPERATION]),
        ),
      );

    if (operating) {
      throw AppError.conflict(
        'STACK_OPERATION_CONFLICT',
        'An operation on this stack has not been resolved yet.',
      );
    }
  }

  /**
   * Reads the host again, and says whether the answer was complete.
   *
   * Completeness is the point of asking. Every conclusion about an attempt
   * turns on a container being there or not being there, and a pass that
   * stopped halfway establishes neither.
   */
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
          event: 'stack_apply_sync_failed',
          hostId,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'the host could not be read while reconciling a stack revision',
      );

      return false;
    }
  }

  private async find(stackId: string) {
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

    return stack;
  }

  private async revision(stackId: string, revisionId: string): Promise<RevisionRow> {
    const [revision] = await this.db.client
      .select()
      .from(stackRevisions)
      .where(and(eq(stackRevisions.id, revisionId), eq(stackRevisions.stackId, stackId)));

    if (!revision) {
      throw AppError.notFound('STACK_NOT_FOUND', 'The revision does not exist.');
    }

    return revision;
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
type RevisionRow = typeof stackRevisions.$inferSelect;
type ContainerRow = {
  id: string;
  dockerId: string | null;
  name: string;
  state: string;
  stackService: string | null;
  stackRevisionId: string | null;
};

type DeploymentDetail = NonNullable<typeof stackDeployments.$inferInsert.detail>;

interface DispatchedApply {
  readonly deploymentId: string;
  readonly actionId: string | null;
  readonly kind: ApplyKind;
  readonly stackId: string;
  readonly stackName: string;
  readonly hostId: string;
  readonly revisionId: string;
  readonly fromRevisionId: string | null;
  readonly targetServices: readonly string[];
  readonly fromServices: readonly string[] | null;
  readonly agentId: string;
  /** Service name to the container resource allocated for it. */
  readonly containers: ReadonlyMap<string, string>;
  readonly payload: AgentStackPlan;
  readonly actor: AuthenticatedUser;
  readonly context: RequestContext;
}

/** The service names a revision describes, from its own summary. */
function summaryServices(revision: RevisionRow | null): readonly string[] | null {
  return revision?.summary ? [...revision.summary.services] : null;
}

/** The volume keys a revision describes, from its own summary. */
function summaryVolumes(revision: RevisionRow | null): readonly string[] {
  return revision?.summary ? [...revision.summary.volumes] : [];
}

/** Resources of this stack that no container on the host claims. */
function unclaimed(stackId: string) {
  return and(eq(containers.stackId, stackId), isNull(containers.dockerId));
}

/**
 * Resources for services the applied revision does not have.
 *
 * Guarded against the empty case deliberately: a condition that narrowed to
 * nothing would delete every container of the stack, and a delete that means
 * "everything" when it was meant to mean "the leftovers" is the kind of thing
 * that only shows up once.
 */
function orphanedServices(attempt: DispatchedApply) {
  const kept = [...attempt.containers.values()];

  if (kept.length === 0) {
    return sql`false`;
  }

  return and(eq(containers.stackId, attempt.stackId), ...kept.map((id) => ne(containers.id, id)));
}

/**
 * Which of the four this is, and null when there is nothing to do.
 *
 * Nothing to do means the stack is running that revision and has nothing wrong
 * with it. A stack that needs attention is never nothing to do, even when the
 * revision asked for is the one it is supposed to be running: that is exactly
 * what repairing it means.
 *
 * Rollback and redeploy do the same thing and differ only in which direction
 * the revision numbers go, which is the word an operator reads afterwards.
 */
function kindOf(stack: StackRow, target: RevisionRow, from: RevisionRow | null): ApplyKind | null {
  if (stack.status === 'needs_attention') {
    return 'repair';
  }

  if (from === null) {
    return 'initial';
  }

  if (from.id === target.id) {
    return null;
  }

  return target.number < from.number ? 'rollback' : 'redeploy';
}

/** The statuses that mean an attempt is not over. */
export const UNRESOLVED_DEPLOYMENT = ['pending', 'running', 'interrupted'] as const;

/** A stack's key in the mutation registry, which containers also live in. */
export function stackKey(stackId: string): string {
  return `stack:${stackId}`;
}

/**
 * Turns a lost race into an answer rather than a constraint violation.
 *
 * The guards above are read before this transaction and hold within one
 * process. The database is what holds across two of them, and what it says when
 * a second control server got there first is a unique-violation — which is
 * correct, and is not a sentence to put in front of an operator.
 */
function claimed(error: unknown): unknown {
  const constraint = (error as { constraint?: string }).constraint;

  if (constraint === 'stack_deployments_unresolved_unique') {
    return AppError.conflict(
      'STACK_DEPLOYMENT_CONFLICT',
      'An attempt to apply a revision to this stack was started elsewhere and has not been resolved yet.',
    );
  }

  if (constraint === 'containers_host_pending_name_unique') {
    return AppError.conflict(
      'RESOURCE_NAME_CONFLICT',
      'A container this stack needs is already being created on this host.',
    );
  }

  return error;
}

/**
 * The failures that say nothing about the host.
 *
 * The same set the container operations use, for the same reason: a timeout
 * means the server stopped waiting, not that Docker stopped working, and a lost
 * connection may have carried away the answer to something that happened.
 */
const UNKNOWN_OUTCOME = new Set(['AGENT_REQUEST_TIMEOUT', 'AGENT_NOT_CONNECTED']);

const AUDIT_REQUESTED: Record<ApplyKind, AuditAction> = {
  initial: 'stack.deploy.requested',
  redeploy: 'stack.redeploy.requested',
  rollback: 'stack.rollback.requested',
  repair: 'stack.repair.requested',
};

const AUDIT_SUCCEEDED: Record<ApplyKind, AuditAction> = {
  initial: 'stack.deploy.succeeded',
  redeploy: 'stack.redeployed',
  rollback: 'stack.rolled_back',
  repair: 'stack.repaired',
};
