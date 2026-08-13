import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
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
  containerDesiredConfigs,
  containerEnvironmentVariables,
  containers,
  hosts,
} from '../database/schema';
import { EventsService } from '../events/events.service';
import { MutationRegistry } from '../operations/mutation-registry';
import {
  CreateContainerRequest,
  RemoveContainerRequest,
  ReplaceContainerRequest,
} from './container-spec';
import { configurationOf, presentEnvironment, resolveEnvironment, specFor } from './desired-config';
import { PendingMutationGuard } from './pending-guard';
import { ReconciliationService } from './reconciliation.service';
import { RecoveryDecision } from './recovery';

/** What the caller is told about a container change. */
export interface ManagementOutcome {
  readonly actionId: string;
  readonly containerId: string;
  readonly status: 'succeeded' | 'failed' | 'unresolved';
  readonly state?: string;
  readonly dockerId?: string | null;
}

interface RequestContext {
  readonly sourceIp?: string;
  readonly userAgent?: string;
  readonly requestId?: string;
}

/**
 * Creating, replacing and removing containers.
 *
 * Every one of these changes a host, and none of them can be undone by a
 * database. That single fact shapes the whole service: what the container is
 * meant to become is written and committed before an agent is asked for
 * anything, the agent is asked outside any transaction, and what actually
 * happened is established by reading the host afterwards rather than by
 * believing the reply.
 *
 * The reply is not ignored, but it is not authoritative either. An agent that
 * says a replacement rolled back and a host that shows the replacement running
 * disagree about something the host is closer to, and the host wins.
 *
 * The hardest case is the one where there is no reply at all. A dispatch that
 * times out or loses its connection leaves the server unable to say whether
 * Docker did anything, and the only honest response is to say so: the operation
 * stays unresolved, the container stays blocked, and the next complete
 * discovery pass settles it. Nothing is retried and nothing is guessed.
 */
@Injectable()
export class ContainerManagementService {
  constructor(
    private readonly db: Database,
    private readonly mutations: MutationRegistry,
    private readonly pending: PendingMutationGuard,
    private readonly dispatch: AgentDispatchService,
    private readonly connections: AgentConnectionManager,
    private readonly reconciliation: ReconciliationService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Creates a container.
   *
   * The resource is written before the agent is asked, which is what makes a
   * crash mid-create answerable: something exists to find afterwards, carrying
   * the name that was claimed and the configuration that was intended.
   */
  async create(
    request: CreateContainerRequest,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<ManagementOutcome> {
    const host = await this.host(request.hostId);
    const agentId = await this.connectedAgent(host.id);

    // Before the lock, so a caller learns the name is taken without waiting for
    // whatever else is happening on this host.
    await this.pending.assertNameFree(host.id, request.name);

    const release = this.mutations.acquire(
      MutationRegistry.nameKey(host.id, request.name),
      'create',
    );

    try {
      const prepared = await this.prepareCreate(request, host.id, actor, context);

      return await this.runOperation({
        operation: 'create',
        capability: 'container.create',
        agentId,
        containerId: prepared.containerId,
        containerName: request.name,
        hostId: host.id,
        actionId: prepared.actionId,
        actor,
        context,
        payload: {
          containerId: prepared.containerId,
          desiredConfigId: prepared.desiredConfigId,
          spec: prepared.spec,
        },
      });
    } finally {
      release();
    }
  }

  /**
   * Replaces a container with a new configuration.
   *
   * The candidate is built here, from what the container is supposed to be plus
   * what the operator changed — not from what the browser sent alone, which
   * never contains the secrets and must not be able to.
   */
  async replace(
    containerId: string,
    request: ReplaceContainerRequest,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<ManagementOutcome> {
    const target = await this.mutable(containerId);
    const agentId = await this.connectedAgent(target.hostId);
    const release = this.mutations.acquire(containerId, 'replace');

    try {
      /*
       * Resolved inside the lock. Between the guard and here, a replacement
       * that finished would have given this resource a different Docker
       * container, and sending the one read earlier would rebuild something
       * that no longer exists.
       */
      const dockerId = await this.dockerId(containerId);
      const prepared = await this.prepareReplace(containerId, request, actor, context);

      return await this.runOperation({
        operation: 'replace',
        capability: 'container.replace',
        agentId,
        containerId,
        containerName: prepared.name,
        hostId: target.hostId,
        actionId: prepared.actionId,
        actor,
        context,
        payload: {
          dockerId,
          containerId,
          desiredConfigId: prepared.desiredConfigId,
          spec: prepared.spec,
        },
      });
    } finally {
      release();
    }
  }

  /**
   * Removes a container, and never its volumes.
   *
   * There is no candidate configuration to write, but there is still an
   * operation to record: a removal that was dispatched and never confirmed has
   * to be findable afterwards, or the resource would sit in the interface with
   * nobody able to say whether the container behind it still exists.
   */
  async remove(
    containerId: string,
    request: RemoveContainerRequest,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<ManagementOutcome> {
    const target = await this.mutable(containerId);
    const agentId = await this.connectedAgent(target.hostId);
    const release = this.mutations.acquire(containerId, 'remove');

    try {
      const dockerId = await this.dockerId(containerId);

      const actionId = await this.db.client.transaction(async (tx) => {
        const [action] = await tx
          .insert(actions)
          .values({
            actorUserId: actor.id,
            actorKind: 'user',
            capability: 'container.remove',
            targetType: 'container',
            targetId: containerId,
            hostId: target.hostId,
            status: 'running',
            requestedAt: new Date(),
            startedAt: new Date(),
            correlationId: context.requestId ?? randomUUID(),
          })
          .returning({ id: actions.id });

        return action.id;
      });

      await this.auditRequested('container.remove.requested', actionId, target, actor, context);

      return await this.runOperation({
        operation: 'remove',
        capability: 'container.remove',
        agentId,
        containerId,
        containerName: target.name,
        hostId: target.hostId,
        actionId,
        actor,
        context,
        payload: { dockerId, stopFirst: request.stopFirst },
      });
    } finally {
      release();
    }
  }

  /**
   * What a container is configured to be, as an operator may see it.
   *
   * The configuration Dockplane holds, not the container Docker is running:
   * they are the same thing when nothing is in flight and deliberately not
   * during a change. Secret values are absent — reported as being secret and
   * nothing else, because a masked string of the right length measures the
   * secret and a real one hands it out.
   */
  async configuration(containerId: string) {
    const [container] = await this.db.client
      .select()
      .from(containers)
      .where(eq(containers.id, containerId));

    if (!container) {
      throw AppError.notFound('CONTAINER_NOT_FOUND', 'The container does not exist.');
    }

    const configs = await this.db.client
      .select()
      .from(containerDesiredConfigs)
      .where(eq(containerDesiredConfigs.containerId, containerId));

    const current = configs.find((row) => row.state === 'current');

    if (!current) {
      throw AppError.conflict(
        'CONTAINER_NOT_MANAGED',
        'Dockplane has never been told what this container should be.',
      );
    }

    const environment = await this.db.client
      .select()
      .from(containerEnvironmentVariables)
      .where(eq(containerEnvironmentVariables.desiredConfigId, current.id));

    return {
      configuration: {
        name: container.name,
        image: current.image,
        hostname: current.hostname,
        command: current.command,
        entrypoint: current.entrypoint,
        ports: current.ports,
        mounts: current.mounts,
        networks: current.networks,
        restartPolicy: current.restartPolicy,
        labels: current.labels,
        healthcheck: current.healthcheck,
        environment: presentEnvironment(environment),
      },
      /** True while a change to this container has not been settled. */
      reconciling: configs.some((row) => row.state === 'pending'),
    };
  }

  /**
   * Dispatches, then establishes what happened.
   *
   * Deliberately one path for all three operations, because the part that is
   * easy to get wrong is the same for all three: what to do when the answer
   * does not arrive.
   */
  private async runOperation(operation: DispatchedOperation): Promise<ManagementOutcome> {
    let failure: AppError | undefined;

    try {
      await this.dispatch.request(operation.agentId, operation.capability, operation.payload);
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'DOCKER_OPERATION_FAILED';

      if (UNKNOWN_OUTCOME.has(code)) {
        return await this.unresolved(operation, code);
      }

      /*
       * A refusal the agent was able to state. Docker may still have been
       * touched — a replacement that rolled back did stop and start a
       * container — so the host is read before anything is concluded, exactly
       * as it is after a success.
       */
      failure = error instanceof AppError ? error : undefined;
    }

    const decision = await this.reconciliation.reconcileAndFinalize({
      containerId: operation.containerId,
      containerName: operation.containerName,
      hostId: operation.hostId,
      operation: operation.operation,
      actionId: operation.actionId,
    });

    return await this.report(operation, decision, failure);
  }

  /**
   * The case where the server cannot say what happened.
   *
   * Nothing is written down as an outcome, because there is no outcome to write
   * down. The action stays open, the candidate configuration stays where it is,
   * and the guard that reads it keeps refusing further operations — so a client
   * that retries after a timeout is turned away rather than starting a second
   * change against a container that may already be halfway through the first.
   */
  private async unresolved(
    operation: DispatchedOperation,
    code: string,
  ): Promise<ManagementOutcome> {
    this.logger.warn(
      {
        event: 'container_operation_outcome_unknown',
        containerId: operation.containerId,
        hostId: operation.hostId,
        operation: operation.operation,
        actionId: operation.actionId,
        reason: code,
      },
      'a container operation was dispatched and its outcome is not known',
    );

    /*
     * Audited as interrupted rather than failed. "Failed" would be a claim
     * about a host nobody has heard from, and an operator reading it later
     * would be reading something the server never established.
     */
    await this.audit.record({
      action: `${AUDIT[operation.operation]}.interrupted` as AuditAction,
      result: 'failure',
      actorUserId: operation.actor.id,
      actorLabel: operation.actor.email,
      targetType: 'container',
      targetId: operation.containerId,
      targetLabel: operation.containerName,
      reasonCode: operation.actionId ?? code,
      sourceIp: operation.context.sourceIp,
      userAgent: operation.context.userAgent,
    });

    throw new AppError(
      'OPERATION_OUTCOME_UNKNOWN',
      'The request reached the host but its result did not come back. Dockplane will establish what happened from the host and will not repeat the operation; the container accepts no further changes until then.',
      503,
    );
  }

  /** Turns a reconciled decision into what the operator is told. */
  private async report(
    operation: DispatchedOperation,
    decision: RecoveryDecision,
    failure: AppError | undefined,
  ): Promise<ManagementOutcome> {
    const [container] = await this.db.client
      .select({ dockerId: containers.dockerId, state: containers.state })
      .from(containers)
      .where(eq(containers.id, operation.containerId));

    const succeeded = decision.kind === 'promote_pending' || decision.kind === 'finalize_remove';

    await this.audit.record({
      action: `${AUDIT[operation.operation]}.${succeeded ? 'succeeded' : 'failed'}` as AuditAction,
      result: succeeded ? 'success' : 'failure',
      actorUserId: operation.actor.id,
      actorLabel: operation.actor.email,
      targetType: 'container',
      targetId: operation.containerId,
      targetLabel: operation.containerName,
      reasonCode: operation.actionId ?? undefined,
      sourceIp: operation.context.sourceIp,
      userAgent: operation.context.userAgent,
    });

    if (succeeded) {
      await this.events.record({
        hostId: operation.hostId,
        type: EVENT[operation.operation],
        resource: `container:${operation.containerId}`,
        message: `${operation.containerName} was ${PAST[operation.operation]} by ${operation.actor.email}.`,
        correlationId: operation.actionId ?? undefined,
      });

      return {
        actionId: operation.actionId!,
        containerId: operation.containerId,
        status: 'succeeded',
        state: container?.state,
        dockerId: container?.dockerId,
      };
    }

    if (decision.kind === 'discard_pending' || decision.kind === 'fail_operation') {
      /*
       * Established, not assumed: the host was read and the change is not
       * there. The agent's own message is preferred when it had one, because
       * it says why.
       */
      throw new AppError(
        failure?.code ?? OUTCOME_FAILURE[operation.operation],
        failure?.message ?? 'The change was not applied. The container is as it was.',
        409,
      );
    }

    if (decision.kind === 'identity_conflict') {
      throw AppError.conflict(
        'CONTAINER_IDENTITY_CONFLICT',
        'More than one container claims to be this one, so nothing may be concluded about it.',
      );
    }

    /*
     * needs_attention, or a snapshot that did not complete. Both mean the same
     * thing to a caller: the host was not readable well enough to say what
     * happened, and the operation is still open.
     */
    throw new AppError(
      'OPERATION_OUTCOME_UNKNOWN',
      'The host could not be read well enough to establish what happened. Dockplane will settle it from the host and will not repeat the operation.',
      503,
    );
  }

  /** Writes the resource and the configuration it is meant to become. */
  private async prepareCreate(
    request: CreateContainerRequest,
    hostId: string,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const environment = resolveEnvironment(request.environment, [], this.box);

    const prepared = await this.db.client.transaction(async (tx) => {
      const [container] = await tx
        .insert(containers)
        .values({
          hostId,
          dockerId: null,
          name: request.name,
          image: request.image,
          state: 'creating',
          observedAt: new Date(),
        })
        .returning({ id: containers.id });

      const [action] = await tx
        .insert(actions)
        .values({
          actorUserId: actor.id,
          actorKind: 'user',
          capability: 'container.create',
          targetType: 'container',
          targetId: container.id,
          hostId,
          status: 'running',
          requestedAt: new Date(),
          startedAt: new Date(),
          correlationId: context.requestId ?? randomUUID(),
        })
        .returning({ id: actions.id });

      const [config] = await tx
        .insert(containerDesiredConfigs)
        .values({
          containerId: container.id,
          state: 'pending',
          actionId: action.id,
          createdBy: actor.id,
          ...configurationOf(request),
        })
        .returning({ id: containerDesiredConfigs.id });

      if (environment.length > 0) {
        await tx
          .insert(containerEnvironmentVariables)
          .values(environment.map((variable) => ({ desiredConfigId: config.id, ...variable })));
      }

      return { containerId: container.id, actionId: action.id, desiredConfigId: config.id };
    });

    await this.auditRequested(
      'container.create.requested',
      prepared.actionId,
      { containerId: prepared.containerId, name: request.name },
      actor,
      context,
    );

    const [config] = await this.db.client
      .select()
      .from(containerDesiredConfigs)
      .where(eq(containerDesiredConfigs.id, prepared.desiredConfigId));

    const stored = await this.db.client
      .select()
      .from(containerEnvironmentVariables)
      .where(eq(containerEnvironmentVariables.desiredConfigId, prepared.desiredConfigId));

    return { ...prepared, spec: specFor(request.name, config, stored, this.box) };
  }

  /** Builds the candidate from what the container is plus what changed. */
  private async prepareReplace(
    containerId: string,
    request: ReplaceContainerRequest,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const [container] = await this.db.client
      .select()
      .from(containers)
      .where(eq(containers.id, containerId));

    const [current] = await this.db.client
      .select()
      .from(containerDesiredConfigs)
      .where(
        and(
          eq(containerDesiredConfigs.containerId, containerId),
          eq(containerDesiredConfigs.state, 'current'),
        ),
      );

    if (!current) {
      throw AppError.conflict(
        'CONTAINER_NOT_MANAGED',
        'Dockplane has never been told what this container should be, so there is nothing to change.',
      );
    }

    const previous = await this.db.client
      .select()
      .from(containerEnvironmentVariables)
      .where(eq(containerEnvironmentVariables.desiredConfigId, current.id));

    const environment = resolveEnvironment(request.environment, previous, this.box);
    const name = request.name ?? container.name;

    const prepared = await this.db.client.transaction(async (tx) => {
      const [action] = await tx
        .insert(actions)
        .values({
          actorUserId: actor.id,
          actorKind: 'user',
          capability: 'container.replace',
          targetType: 'container',
          targetId: containerId,
          hostId: container.hostId,
          status: 'running',
          requestedAt: new Date(),
          startedAt: new Date(),
          correlationId: context.requestId ?? randomUUID(),
        })
        .returning({ id: actions.id });

      const [candidate] = await tx
        .insert(containerDesiredConfigs)
        .values({
          containerId,
          state: 'pending',
          actionId: action.id,
          createdBy: actor.id,
          ...configurationOf(request),
        })
        .returning({ id: containerDesiredConfigs.id });

      if (environment.length > 0) {
        await tx
          .insert(containerEnvironmentVariables)
          .values(environment.map((variable) => ({ desiredConfigId: candidate.id, ...variable })));
      }

      return { actionId: action.id, desiredConfigId: candidate.id };
    });

    await this.auditRequested(
      'container.replace.requested',
      prepared.actionId,
      { containerId, name },
      actor,
      context,
    );

    const [candidate] = await this.db.client
      .select()
      .from(containerDesiredConfigs)
      .where(eq(containerDesiredConfigs.id, prepared.desiredConfigId));

    const stored = await this.db.client
      .select()
      .from(containerEnvironmentVariables)
      .where(eq(containerEnvironmentVariables.desiredConfigId, prepared.desiredConfigId));

    return { ...prepared, name, spec: specFor(name, candidate, stored, this.box) };
  }

  /**
   * The checks a container has to pass before anything may be done to it.
   *
   * In this order for a reason. What the resource is comes first, then whether
   * it is Dockplane's to change at all, then whether its state permits it — and
   * only afterwards is a host or a Docker identifier involved. Resolving an
   * address for a container nobody may touch is work that should never have
   * started.
   */
  private async mutable(containerId: string): Promise<MutableTarget> {
    const [row] = await this.db.client
      .select({
        id: containers.id,
        name: containers.name,
        hostId: containers.hostId,
        dockerId: containers.dockerId,
        composeProjectId: containers.composeProjectId,
        stackId: containers.stackId,
      })
      .from(containers)
      .where(eq(containers.id, containerId));

    if (!row) {
      throw AppError.notFound('CONTAINER_NOT_FOUND', 'The container does not exist.');
    }

    await this.pending.assertOperable(containerId);

    if (row.composeProjectId || row.stackId) {
      /*
       * Its configuration comes from a stack's Compose file. Replacing or
       * removing it on its own would leave the stack describing something that
       * is not there, and the next deployment would find a container it did not
       * make.
       */
      throw AppError.conflict(
        'MANAGED_BY_STACK',
        'This container belongs to a Compose project, and its configuration comes from there.',
      );
    }

    const [managed] = await this.db.client
      .select({ id: containerDesiredConfigs.id })
      .from(containerDesiredConfigs)
      .where(eq(containerDesiredConfigs.containerId, containerId));

    if (!managed) {
      /*
       * Found by discovery, never described to Dockplane. Replacing it would
       * mean inventing a configuration for somebody else's container out of
       * what can be observed of it, and what can be observed is deliberately
       * not enough — the environment is not there.
       */
      throw AppError.conflict(
        'CONTAINER_NOT_MANAGED',
        'Dockplane did not create this container, so it will not change or remove it.',
      );
    }

    return { containerId: row.id, name: row.name, hostId: row.hostId };
  }

  /** Read inside the lock, because a replacement changes it. */
  private async dockerId(containerId: string): Promise<string> {
    const [row] = await this.db.client
      .select({ dockerId: containers.dockerId })
      .from(containers)
      .where(eq(containers.id, containerId));

    if (!row?.dockerId) {
      throw AppError.notFound('CONTAINER_NOT_FOUND', 'The container does not exist on its host.');
    }

    return row.dockerId;
  }

  private async host(hostId: string) {
    const [row] = await this.db.client
      .select({ id: hosts.id, hostname: hosts.hostname })
      .from(hosts)
      .where(eq(hosts.id, hostId));

    if (!row) {
      throw AppError.notFound('HOST_NOT_FOUND', 'The host does not exist.');
    }

    return row;
  }

  /** The same rule the lifecycle uses: performed now, or refused. */
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
        'The agent is not connected, so the operation cannot be carried out now.',
      );
    }

    return agent.id;
  }

  /** Recorded before the dispatch, so an interrupted operation still has a trail. */
  private async auditRequested(
    action: AuditAction,
    actionId: string,
    target: { containerId: string; name: string },
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<void> {
    await this.audit.record({
      action,
      result: 'success',
      actorUserId: actor.id,
      actorLabel: actor.email,
      targetType: 'container',
      targetId: target.containerId,
      targetLabel: target.name,
      reasonCode: actionId,
      sourceIp: context.sourceIp,
      userAgent: context.userAgent,
    });
  }
}

interface MutableTarget {
  readonly containerId: string;
  readonly name: string;
  readonly hostId: string;
}

interface DispatchedOperation {
  readonly operation: 'create' | 'replace' | 'remove';
  readonly capability: 'container.create' | 'container.replace' | 'container.remove';
  readonly agentId: string;
  readonly containerId: string;
  readonly containerName: string;
  readonly hostId: string;
  readonly actionId: string | null;
  readonly actor: AuthenticatedUser;
  readonly context: RequestContext;
  readonly payload: Record<string, unknown>;
}

/**
 * The failures that say nothing about the host.
 *
 * A timeout means the server stopped waiting, not that Docker stopped working.
 * A lost connection is the same: the request may have been read, acted on, and
 * had its answer thrown away with the socket.
 *
 * `AGENT_NOT_CONNECTED` covers both a request that was never sent and a
 * connection that closed before the answer came back, and from here they are
 * indistinguishable. It is counted as unknown, because the cost of being wrong
 * runs one way: calling an unknown outcome unknown leaves an operation for
 * reconciliation to settle, while calling it failed puts a claim about a host
 * nobody has heard from into the record.
 */
const UNKNOWN_OUTCOME = new Set(['AGENT_REQUEST_TIMEOUT', 'AGENT_NOT_CONNECTED']);

const AUDIT = {
  create: 'container.create',
  replace: 'container.replace',
  remove: 'container.remove',
} as const;

const EVENT = {
  create: 'container.created',
  replace: 'container.replaced',
  remove: 'container.removed',
} as const;

const PAST = { create: 'created', replace: 'replaced', remove: 'removed' } as const;

const OUTCOME_FAILURE = {
  create: 'CONTAINER_CREATE_FAILED',
  replace: 'REPLACEMENT_FAILED',
  remove: 'CONTAINER_REMOVE_FAILED',
} as const;
