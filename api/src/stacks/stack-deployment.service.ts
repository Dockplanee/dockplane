import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Logger } from 'pino';

import { AgentDispatchService } from '../agents/agent-dispatch.service';
import { AgentConnectionManager } from '../agents/connection-manager.service';
import { AuditService } from '../audit/audit.service';
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
  stackRevisionEnvironment,
  stackRevisions,
  stacks,
} from '../database/schema';
import { DiscoveryService } from '../discovery/discovery.service';
import { EventsService } from '../events/events.service';
import { MutationRegistry } from '../operations/mutation-registry';
import { ComposeCompilerService, StackDeploymentPlan } from './compose-compiler.service';
import { StackDeploymentOutcome, classifyStackDeployment } from './stack-deployment';
import { AgentStackPlan, agentPlanFor, containerNames } from './stack-plan';

/** What the caller is told about a deployment. */
export interface DeploymentOutcome {
  readonly deploymentId: string;
  readonly stackId: string;
  readonly revisionId: string;
  readonly status: 'succeeded';
  readonly services: readonly { serviceName: string; state: string | null }[];
}

interface RequestContext {
  readonly sourceIp?: string;
  readonly userAgent?: string;
  readonly requestId?: string;
}

/**
 * Putting a stack on a host for the first time.
 *
 * The shape of this is the container management service's, for the same
 * reasons: what is intended is written and committed before an agent is asked
 * for anything, the agent is asked outside any transaction, and what actually
 * happened is established by reading the host rather than by believing the
 * reply. A deployment creates several containers instead of one, which changes
 * how much can be half-done and nothing about the order.
 *
 * Three things are specific to a stack.
 *
 * The revision is compiled again, here, from the source and environment that
 * were stored. A plan is never persisted — it carries resolved secrets — so the
 * only way to deploy what a revision means is to produce the plan afresh.
 *
 * The containers are allocated before the dispatch, one per service, and the
 * agent stamps their identifiers onto what it creates. That is what makes a
 * deployment that lost its answer answerable: the containers on the host say
 * which service of which stack they are.
 *
 * A partial deployment is a real outcome. Some services running and some not is
 * not tidied away and not rolled back: containers that started may already have
 * written to a volume, so the attempt is recorded as needing attention and the
 * stack is not marked as deployed.
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
   * Deploys a revision of a stack that has never run.
   *
   * Only the first deployment. A stack that already has a deployed revision is
   * refused here rather than being quietly turned into an update: replacing
   * what is running is a different operation with different consequences, and
   * it does not exist yet.
   */
  async deploy(
    stackId: string,
    revisionId: string,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<DeploymentOutcome> {
    const stack = await this.find(stackId);

    if (stack.currentRevisionId) {
      throw AppError.conflict(
        'STACK_ALREADY_DEPLOYED',
        'This stack is already deployed. Changing what is running is not something this version can do.',
      );
    }

    if (stack.latestRevisionId !== revisionId) {
      throw AppError.conflict(
        'STACK_REVISION_CONFLICT',
        'That is not the newest revision of this stack. Reload it and deploy again.',
      );
    }

    const revision = await this.revision(stackId, revisionId);
    const agentId = await this.connectedAgent(stack.hostId);

    /*
     * Two guards, answering different questions.
     *
     * The lock answers "is a deployment of this stack running right now"; the
     * unresolved attempt in the database answers "did one never finish". A
     * restart clears the first and leaves the second exactly as it was, which
     * is the case that matters: the containers a half-finished deployment
     * created are still on the host.
     */
    await this.assertNoUnresolvedDeployment(stackId);

    const release = this.mutations.acquire(stackKey(stackId), 'deploy');

    try {
      const plan = await this.compile(stack.name, revision);
      const names = containerNames(plan);

      await this.assertNamesAreFree(stack.hostId, names);

      const prepared = await this.prepare({
        stack,
        revisionId,
        plan,
        names,
        actor,
        context,
      }).catch((error: unknown) => {
        throw claimed(error);
      });

      await this.audit.record({
        action: 'stack.deploy.requested',
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
        stackId,
        stackName: stack.name,
        hostId: stack.hostId,
        revisionId,
        agentId,
        containers: prepared.containers,
        payload: agentPlanFor({
          stackId,
          revisionId,
          plan,
          containers: prepared.containers,
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
   * The reply is not what decides the outcome. An agent that says a deployment
   * completed and a host with two of three containers running disagree about
   * something the host is closer to.
   */
  private async run(deployment: DispatchedDeployment): Promise<DeploymentOutcome> {
    let failure: AppError | undefined;

    try {
      await this.dispatch.request(deployment.agentId, 'stack.deploy', {
        plan: deployment.payload,
      });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'DOCKER_OPERATION_FAILED';

      if (UNKNOWN_OUTCOME.has(code)) {
        return await this.interrupted(deployment, code);
      }

      /*
       * A refusal the agent was able to state. Docker may still have been
       * changed — a deployment that failed on its third service created two
       * containers first — so the host is read before anything is concluded,
       * exactly as it is after a success.
       */
      failure = error instanceof AppError ? error : undefined;
    }

    const observed = await this.observe(deployment);

    return await this.settle(deployment, observed, failure);
  }

  /**
   * The case where the server cannot say what happened.
   *
   * Nothing is concluded and nothing is dispatched again. The attempt stays
   * unresolved, which keeps the stack blocked, and the next complete discovery
   * of that host settles it.
   */
  private async interrupted(deployment: DispatchedDeployment, code: string): Promise<never> {
    this.logger.warn(
      {
        event: 'stack_deployment_outcome_unknown',
        stackId: deployment.stackId,
        hostId: deployment.hostId,
        deploymentId: deployment.deploymentId,
        reason: code,
      },
      'a stack deployment was dispatched and its outcome is not known',
    );

    await this.db.client
      .update(stackDeployments)
      .set({ status: 'interrupted', failureCode: code, updatedAt: new Date() })
      .where(eq(stackDeployments.id, deployment.deploymentId));

    await this.audit.record({
      action: 'stack.deploy.interrupted',
      result: 'failure',
      actorUserId: deployment.actor.id,
      actorLabel: deployment.actor.email,
      targetType: 'stack',
      targetId: deployment.stackId,
      targetLabel: deployment.stackName,
      reasonCode: deployment.deploymentId,
      sourceIp: deployment.context.sourceIp,
      userAgent: deployment.context.userAgent,
    });

    throw new AppError(
      'OPERATION_OUTCOME_UNKNOWN',
      'The request reached the host but its result did not come back. Dockplane will establish what happened from the host and will not repeat the deployment; the stack accepts no further deployments until then.',
      503,
    );
  }

  /** Reads the host and compares it with what the deployment was to produce. */
  private async observe(deployment: DispatchedDeployment) {
    const snapshotComplete = await this.resync(deployment.hostId);

    const rows = await this.db.client
      .select({
        id: containers.id,
        dockerId: containers.dockerId,
        state: containers.state,
      })
      .from(containers)
      .where(eq(containers.stackId, deployment.stackId));

    /*
     * Keyed by the resource this attempt allocated, not by the service name.
     * The question being asked is whether the container this deployment set out
     * to create exists — and a row that is the same service but a different
     * resource is a different container.
     */
    const byResource = new Map(rows.map((row) => [row.id, row]));

    const services = [...deployment.containers.entries()].map(([serviceName, containerId]) => {
      const row = byResource.get(containerId);

      return {
        serviceName,
        containerId,
        dockerId: row?.dockerId ?? null,
        state: row?.dockerId ? (row.state ?? null) : null,
      };
    });

    return {
      snapshotComplete,
      services,
      outcome: classifyStackDeployment({ services, snapshotComplete }),
    };
  }

  /** Writes what was established, and only then calls the stack deployed. */
  private async settle(
    deployment: DispatchedDeployment,
    observed: {
      snapshotComplete: boolean;
      services: {
        serviceName: string;
        containerId: string;
        dockerId: string | null;
        state: string | null;
      }[];
      outcome: StackDeploymentOutcome;
    },
    failure: AppError | undefined,
  ): Promise<DeploymentOutcome> {
    const detail = {
      services: observed.services.map((service) => ({
        serviceName: service.serviceName,
        containerId: service.containerId,
        ...(service.state ? { state: service.state } : {}),
      })),
    };

    this.logger.info(
      {
        event: 'stack_deployment_reconciled',
        stackId: deployment.stackId,
        hostId: deployment.hostId,
        deploymentId: deployment.deploymentId,
        snapshotComplete: observed.snapshotComplete,
        outcome: observed.outcome.kind,
      },
      'a stack deployment was reconciled against the host',
    );

    if (observed.outcome.kind === 'succeeded') {
      await this.recordSuccess(deployment, detail);

      return {
        deploymentId: deployment.deploymentId,
        stackId: deployment.stackId,
        revisionId: deployment.revisionId,
        status: 'succeeded',
        services: observed.services.map((service) => ({
          serviceName: service.serviceName,
          state: service.state,
        })),
      };
    }

    if (observed.outcome.kind === 'unknown') {
      /*
       * The host could not be read well enough to say. Treated exactly like a
       * dispatch whose answer never came: the attempt stays unresolved and
       * nothing is repeated.
       */
      return await this.interrupted(deployment, 'HOST_NOT_READABLE');
    }

    if (observed.outcome.kind === 'failed') {
      await this.recordFailure(deployment, detail, failure, observed.outcome.reason);

      throw new AppError(
        failure?.code ?? 'STACK_DEPLOYMENT_FAILED',
        failure?.message ?? 'The stack was not deployed. The host is as it was.',
        409,
      );
    }

    await this.recordNeedsAttention(deployment, detail, observed.outcome.reason);

    throw new AppError(
      'STACK_DEPLOYMENT_PARTIAL',
      'Part of this stack is running and part of it is not. Nothing was removed; the stack is not recorded as deployed until somebody resolves it.',
      409,
    );
  }

  /** The only place a stack becomes deployed. */
  private async recordSuccess(
    deployment: DispatchedDeployment,
    detail: DeploymentDetail,
  ): Promise<void> {
    const now = new Date();

    await this.db.client.transaction(async (tx) => {
      await tx
        .update(stackDeployments)
        .set({ status: 'succeeded', detail, resolvedAt: now, updatedAt: now })
        .where(eq(stackDeployments.id, deployment.deploymentId));

      /*
       * Set from the deployment that was confirmed, and compared against the
       * revision this attempt was deploying. A second attempt that finished
       * first would have set it already, and overwriting it would record the
       * older of two answers.
       */
      await tx
        .update(stacks)
        .set({
          currentRevisionId: deployment.revisionId,
          desiredRevisionId: null,
          status: 'running',
          lastDeployedAt: now,
          updatedAt: now,
        })
        .where(and(eq(stacks.id, deployment.stackId), isNull(stacks.currentRevisionId)));

      if (deployment.actionId) {
        await tx
          .update(actions)
          .set({ status: 'succeeded', completedAt: now })
          .where(eq(actions.id, deployment.actionId));
      }
    });

    await this.audit.record({
      action: 'stack.deploy.succeeded',
      result: 'success',
      actorUserId: deployment.actor.id,
      actorLabel: deployment.actor.email,
      targetType: 'stack',
      targetId: deployment.stackId,
      targetLabel: deployment.stackName,
      reasonCode: deployment.deploymentId,
      sourceIp: deployment.context.sourceIp,
      userAgent: deployment.context.userAgent,
    });

    await this.events.record({
      hostId: deployment.hostId,
      type: 'stack.deployed',
      resource: `stack:${deployment.stackId}`,
      message: `${deployment.stackName} was deployed by ${deployment.actor.email}.`,
      correlationId: deployment.deploymentId,
    });
  }

  /**
   * Nothing was created, so nothing is left behind.
   *
   * The container resources allocated for this attempt are removed, because
   * each one holds a name on the host and represents a container that does not
   * exist. They are only ever removed when the host was read completely and
   * showed nothing claiming them.
   */
  private async recordFailure(
    deployment: DispatchedDeployment,
    detail: DeploymentDetail,
    failure: AppError | undefined,
    reason: string,
  ): Promise<void> {
    const now = new Date();

    await this.db.client.transaction(async (tx) => {
      await tx
        .update(stackDeployments)
        .set({
          status: 'failed',
          detail,
          failureCode: failure?.code ?? 'STACK_DEPLOYMENT_FAILED',
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(stackDeployments.id, deployment.deploymentId));

      await tx
        .update(stacks)
        .set({ status: 'not_deployed', desiredRevisionId: null, updatedAt: now })
        .where(eq(stacks.id, deployment.stackId));

      await tx
        .delete(containers)
        .where(
          and(
            eq(containers.stackId, deployment.stackId),
            isNull(containers.dockerId),
            inArray(containers.id, [...deployment.containers.values()]),
          ),
        );

      if (deployment.actionId) {
        await tx
          .update(actions)
          .set({ status: 'failed', completedAt: now, errorCode: failure?.code ?? null })
          .where(eq(actions.id, deployment.actionId));
      }
    });

    await this.audit.record({
      action: 'stack.deploy.failed',
      result: 'failure',
      actorUserId: deployment.actor.id,
      actorLabel: deployment.actor.email,
      targetType: 'stack',
      targetId: deployment.stackId,
      targetLabel: deployment.stackName,
      reasonCode: deployment.deploymentId,
      sourceIp: deployment.context.sourceIp,
      userAgent: deployment.context.userAgent,
    });

    await this.events.record({
      hostId: deployment.hostId,
      type: 'stack.deployment.failed',
      severity: 'warning',
      resource: `stack:${deployment.stackId}`,
      message: `${deployment.stackName} was not deployed: ${reason}.`,
      correlationId: deployment.deploymentId,
    });
  }

  /**
   * Part of it exists.
   *
   * Nothing is removed — not the containers that started, not the volumes they
   * may already have written to, and not the resources allocated for the
   * services that never started, because those name what was expected. The
   * attempt stays unresolved, which is what keeps a second deployment from
   * being started over the top of it.
   */
  private async recordNeedsAttention(
    deployment: DispatchedDeployment,
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
          updatedAt: now,
        })
        .where(eq(stackDeployments.id, deployment.deploymentId));

      await tx
        .update(stacks)
        .set({ status: 'needs_attention', updatedAt: now })
        .where(eq(stacks.id, deployment.stackId));

      if (deployment.actionId) {
        await tx
          .update(actions)
          .set({
            status: 'failed',
            completedAt: now,
            errorCode: 'STACK_DEPLOYMENT_PARTIAL',
          })
          .where(eq(actions.id, deployment.actionId));
      }
    });

    await this.audit.record({
      action: 'stack.deploy.needs_attention',
      result: 'failure',
      actorUserId: deployment.actor.id,
      actorLabel: deployment.actor.email,
      targetType: 'stack',
      targetId: deployment.stackId,
      targetLabel: deployment.stackName,
      reasonCode: deployment.deploymentId,
      sourceIp: deployment.context.sourceIp,
      userAgent: deployment.context.userAgent,
    });

    await this.events.record({
      hostId: deployment.hostId,
      type: 'stack.deployment.failed',
      severity: 'critical',
      resource: `stack:${deployment.stackId}`,
      message: `${deployment.stackName} is partly deployed: ${reason}.`,
      correlationId: deployment.deploymentId,
    });
  }

  /**
   * Writes the attempt, the action and one container resource per service.
   *
   * Short, and committed before anything is dispatched. The container rows are
   * what a deployment that never came back is found by: each carries the name
   * it claimed and the service it is, and the agent stamps its identifier onto
   * the container it builds.
   */
  private async prepare(input: {
    stack: { id: string; name: string; hostId: string };
    revisionId: string;
    plan: StackDeploymentPlan;
    names: Map<string, string>;
    actor: AuthenticatedUser;
    context: RequestContext;
  }) {
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
          revisionId: input.revisionId,
          hostId: input.stack.hostId,
          kind: 'initial',
          status: 'running',
          actionId: action.id,
          startedBy: input.actor.id,
        })
        .returning({ id: stackDeployments.id });

      const allocated = new Map<string, string>();

      for (const service of input.plan.services) {
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
          desiredRevisionId: input.revisionId,
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
   * revision that has become undeployable — an image reference that no longer
   * parses, a variable that was removed — is refused before anything is
   * written, rather than failing on the host.
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

  /**
   * Refuses a deployment whose containers would collide with something.
   *
   * The agent checks this again on the host, where the answer is authoritative
   * and where volumes and networks are checked too. This one exists so that an
   * operator is told what is in the way before an attempt is written down and a
   * host is asked to pull images for it.
   */
  private async assertNamesAreFree(hostId: string, names: ReadonlyMap<string, string>) {
    const existing = await this.db.client
      .select({ name: containers.name, dockerId: containers.dockerId })
      .from(containers)
      .where(eq(containers.hostId, hostId));

    const taken = new Map(existing.map((row) => [row.name.toLowerCase(), row]));

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
   * Refuses a stack whose last deployment never resolved.
   *
   * Read from the database rather than from memory, because the case this
   * exists for is a control server that was restarted while a deployment was in
   * flight. The database refuses a second unresolved attempt as well; this is
   * here so the caller is told what is happening rather than shown a constraint
   * violation.
   */
  private async assertNoUnresolvedDeployment(stackId: string): Promise<void> {
    const [unresolved] = await this.db.client
      .select({ id: stackDeployments.id, status: stackDeployments.status })
      .from(stackDeployments)
      .where(
        and(
          eq(stackDeployments.stackId, stackId),
          inArray(stackDeployments.status, [...UNRESOLVED_DEPLOYMENT]),
        ),
      );

    if (!unresolved) {
      return;
    }

    if (unresolved.status === 'needs_attention') {
      throw AppError.conflict(
        'STACK_NEEDS_ATTENTION',
        'Part of this stack was deployed and part of it was not. Somebody has to resolve that before it can be deployed again.',
      );
    }

    throw AppError.conflict(
      'STACK_DEPLOYMENT_CONFLICT',
      'A deployment of this stack has not been resolved yet.',
    );
  }

  /**
   * Reads the host again, and says whether the answer was complete.
   *
   * Completeness is the point of asking. Every conclusion about a deployment
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
          event: 'stack_deployment_sync_failed',
          hostId,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'the host could not be read while reconciling a stack deployment',
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
        'The agent is not connected, so the stack cannot be deployed now.',
      );
    }

    return agent.id;
  }
}

type RevisionRow = typeof stackRevisions.$inferSelect;

type DeploymentDetail = NonNullable<typeof stackDeployments.$inferInsert.detail>;

interface DispatchedDeployment {
  readonly deploymentId: string;
  readonly actionId: string | null;
  readonly stackId: string;
  readonly stackName: string;
  readonly hostId: string;
  readonly revisionId: string;
  readonly agentId: string;
  /** Service name to the container resource allocated for it. */
  readonly containers: ReadonlyMap<string, string>;
  readonly payload: AgentStackPlan;
  readonly actor: AuthenticatedUser;
  readonly context: RequestContext;
}

/** The statuses that mean a deployment is not over. */
export const UNRESOLVED_DEPLOYMENT = [
  'pending',
  'running',
  'interrupted',
  'needs_attention',
] as const;

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
      'A deployment of this stack was started elsewhere and has not been resolved yet.',
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

/** A stack's key in the mutation registry, which containers also live in. */
export function stackKey(stackId: string): string {
  return `stack:${stackId}`;
}

/**
 * The failures that say nothing about the host.
 *
 * The same set the container operations use, for the same reason: a timeout
 * means the server stopped waiting, not that Docker stopped working, and a lost
 * connection may have carried away the answer to something that happened.
 */
const UNKNOWN_OUTCOME = new Set(['AGENT_REQUEST_TIMEOUT', 'AGENT_NOT_CONNECTED']);
