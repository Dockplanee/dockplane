import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { Logger } from 'pino';

import { AgentDispatchService } from '../agents/agent-dispatch.service';
import { AgentConnectionManager } from '../agents/connection-manager.service';
import { MutatingCapability } from '../agents/capabilities';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/authenticated-request';
import { AppError, ErrorCode } from '../common/errors';
import { LOGGER } from '../config/tokens';
import { Database } from '../database/database';
import { actions, agents, containers, hosts } from '../database/schema';
import { DetailService } from '../discovery/detail.service';
import { EventsService } from '../events/events.service';

/** What an operator asked for, and what came of it. */
export interface ActionOutcome {
  readonly actionId: string;
  readonly status: 'succeeded' | 'failed' | 'timed_out';
  readonly state?: string;
  readonly health?: string;
  readonly observedAt?: Date;
  readonly errorCode?: string;
}

interface AgentResult {
  readonly dockerId?: string;
  readonly state?: string;
  readonly health?: string;
  readonly observedAt?: string;
}

const OPERATIONS = {
  start: {
    capability: 'container.start' as MutatingCapability,
    permission: 'containers.start',
    requested: 'container.start.requested',
    succeeded: 'container.start.succeeded',
    failed: 'container.start.failed',
    event: 'container.started',
  },
  stop: {
    capability: 'container.stop' as MutatingCapability,
    permission: 'containers.stop',
    requested: 'container.stop.requested',
    succeeded: 'container.stop.succeeded',
    failed: 'container.stop.failed',
    event: 'container.stopped',
  },
  restart: {
    capability: 'container.restart' as MutatingCapability,
    permission: 'containers.restart',
    requested: 'container.restart.requested',
    succeeded: 'container.restart.succeeded',
    failed: 'container.restart.failed',
    event: 'container.restarted',
  },
} as const;

export type Operation = keyof typeof OPERATIONS;

/**
 * Container lifecycle.
 *
 * The first thing Dockplane does that changes a host. Everything about how it
 * is shaped follows from that: the browser names a container and an operation
 * from a fixed set, and the server derives the host, the agent and the Docker
 * identifier itself. Nothing a caller sends becomes an instruction.
 *
 * An operation runs only against a connected agent. There is no queue: a stop
 * that was asked for while a host was unreachable must not arrive hours later
 * and take down a service nobody is watching.
 */
@Injectable()
export class LifecycleService {
  /**
   * Containers with an operation in flight.
   *
   * Per container rather than global, so one slow restart does not block a
   * fleet. A second operation on the same container is refused rather than
   * queued: with two in flight, neither the operator nor the audit trail could
   * say which one produced the state that resulted.
   */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly dispatch: AgentDispatchService,
    private readonly connections: AgentConnectionManager,
    private readonly detail: DetailService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Runs one lifecycle operation.
   *
   * The caller has already been authorized: the guard refuses the request
   * before this is reached, so nothing here can be the first check.
   */
  async run(
    operation: Operation,
    containerId: string,
    actor: AuthenticatedUser,
    context: { sourceIp?: string; userAgent?: string; requestId?: string },
  ): Promise<ActionOutcome> {
    const definition = OPERATIONS[operation];

    const target = await this.resolve(containerId);
    const agentId = await this.connectedAgent(target.hostId);

    if (this.inFlight.has(containerId)) {
      throw AppError.conflict(
        'ACTION_CONFLICT',
        'Another operation is already running on this container.',
      );
    }

    this.inFlight.add(containerId);

    const correlationId = context.requestId ?? randomUUID();
    const requestedAt = new Date();

    const [action] = await this.db.client
      .insert(actions)
      .values({
        actorUserId: actor.id,
        actorKind: 'user',
        capability: definition.capability,
        targetType: 'container',
        targetId: target.containerId,
        hostId: target.hostId,
        status: 'running',
        requestedAt,
        startedAt: new Date(),
        correlationId,
      })
      .returning({ id: actions.id });

    await this.audit.record({
      action: definition.requested,
      result: 'success',
      actorUserId: actor.id,
      actorLabel: actor.email,
      targetType: 'container',
      targetId: target.containerId,
      targetLabel: target.name,
      reasonCode: action.id,
      sourceIp: context.sourceIp,
      userAgent: context.userAgent,
    });

    try {
      const result = await this.dispatch.request<AgentResult>(agentId, definition.capability, {
        containerId: target.dockerId,
      });

      return await this.succeed(action.id, operation, target, actor, context, result);
    } catch (error) {
      return await this.fail(action.id, operation, target, actor, context, error);
    } finally {
      this.inFlight.delete(containerId);
    }
  }

  /** Containers with an operation in flight, so the read model can say so. */
  isRunning(containerId: string): boolean {
    return this.inFlight.has(containerId);
  }

  private async succeed(
    actionId: string,
    operation: Operation,
    target: Target,
    actor: AuthenticatedUser,
    context: { sourceIp?: string; userAgent?: string },
    result: AgentResult,
  ): Promise<ActionOutcome> {
    const definition = OPERATIONS[operation];
    const completedAt = new Date();

    await this.db.client
      .update(actions)
      .set({ status: 'succeeded', completedAt })
      .where(eq(actions.id, actionId));

    await this.audit.record({
      action: definition.succeeded,
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

    await this.events.record({
      hostId: target.hostId,
      type: definition.event,
      resource: `container:${target.dockerId}`,
      message: `${target.name} was ${past(operation)} by ${actor.email}.`,
      correlationId: actionId,
    });

    const observed = await this.reconcile(target);

    return {
      actionId,
      status: 'succeeded',
      state: observed?.state ?? result.state,
      health: observed?.health ?? result.health,
      observedAt: observed?.observedAt ?? completedAt,
    };
  }

  private async fail(
    actionId: string,
    operation: Operation,
    target: Target,
    actor: AuthenticatedUser,
    context: { sourceIp?: string; userAgent?: string },
    error: unknown,
  ): Promise<ActionOutcome> {
    const definition = OPERATIONS[operation];
    const failure = error instanceof AppError ? error : undefined;
    const code = failure?.code ?? 'DOCKER_OPERATION_FAILED';
    const timedOut = code === 'AGENT_REQUEST_TIMEOUT';

    await this.db.client
      .update(actions)
      .set({
        status: timedOut ? 'timed_out' : 'failed',
        completedAt: new Date(),
        errorCode: code,
      })
      .where(eq(actions.id, actionId));

    await this.audit.record({
      action: definition.failed,
      result: 'failure',
      actorUserId: actor.id,
      actorLabel: actor.email,
      targetType: 'container',
      targetId: target.containerId,
      targetLabel: target.name,
      reasonCode: code,
      sourceIp: context.sourceIp,
      userAgent: context.userAgent,
    });

    this.logger.warn(
      { event: 'container_action_failed', actionId, capability: definition.capability, code },
      'a container operation failed',
    );

    /*
     * A timeout says the server stopped waiting, not that Docker did nothing.
     * The container is read again so the answer describes the host rather than
     * the request, and the operator is told what is actually true.
     */
    const observed = timedOut ? await this.reconcile(target) : undefined;

    if (timedOut) {
      return {
        actionId,
        status: 'timed_out',
        state: observed?.state,
        health: observed?.health,
        observedAt: observed?.observedAt,
        errorCode: code,
      };
    }

    throw new AppError(code as ErrorCode, failure?.message ?? 'The operation failed.', 409);
  }

  /**
   * Reads the container again after the operation.
   *
   * The agent's answer describes the moment the call returned; discovery is
   * what the interface trusts afterwards. Reconciling here means the response
   * carries an observation rather than an intention, and the interface never
   * has to guess that a start produced a running container.
   *
   * The host is asked again rather than served from the projection cache: a
   * container inspected moments before the operation would otherwise be
   * reported as the state the operation produced.
   */
  private async reconcile(
    target: Target,
  ): Promise<{ state?: string; health?: string; observedAt?: Date } | undefined> {
    try {
      const detail = await this.detail.containerDetail(target.containerId, { force: true });

      return {
        state: detail.detail?.state,
        health: detail.detail?.health,
        observedAt: detail.observedAt ?? undefined,
      };
    } catch (error) {
      // The operation is already recorded; failing to re-read is a gap in what
      // can be reported, not a reason to call a completed action failed.
      this.logger.warn(
        {
          event: 'container_reconcile_failed',
          containerId: target.containerId,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'could not re-read the container after an operation',
      );

      return undefined;
    }
  }

  /** Resolves the container the caller named into what the agent needs. */
  private async resolve(containerId: string): Promise<Target> {
    const [row] = await this.db.client
      .select({
        containerId: containers.id,
        dockerId: containers.dockerId,
        name: containers.name,
        state: containers.state,
        hostId: containers.hostId,
        hostname: hosts.hostname,
      })
      .from(containers)
      .innerJoin(hosts, eq(hosts.id, containers.hostId))
      .where(eq(containers.id, containerId));

    if (!row) {
      throw AppError.notFound('CONTAINER_NOT_FOUND', 'The container does not exist.');
    }

    return row;
  }

  /**
   * Finds the agent that may carry the operation out.
   *
   * A revoked credential is never dispatched to, and neither is a registry row
   * without a live connection: an operation is performed now or refused, never
   * held for a host that might come back.
   */
  private async connectedAgent(hostId: string): Promise<string> {
    const [agent] = await this.db.client
      .select({ id: agents.id, protocolVersion: agents.protocolVersion })
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
}

interface Target {
  readonly containerId: string;
  readonly dockerId: string;
  readonly name: string;
  readonly hostId: string;
  readonly hostname: string;
}

function past(operation: Operation): string {
  return operation === 'stop' ? 'stopped' : operation === 'start' ? 'started' : 'restarted';
}
