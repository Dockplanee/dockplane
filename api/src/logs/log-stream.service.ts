import { randomUUID } from 'node:crypto';

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { Logger } from 'pino';

import { AgentDispatchService, StreamHandle } from '../agents/agent-dispatch.service';
import { AgentConnectionManager } from '../agents/connection-manager.service';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/authenticated-request';
import { SessionService } from '../auth/session.service';
import { AppError, ErrorCode } from '../common/errors';
import { AppConfig, CONFIG } from '../config/configuration';
import { LOGGER } from '../config/tokens';
import { Database } from '../database/database';
import { agents, containers, hosts } from '../database/schema';
import { RbacService } from '../rbac/rbac.service';

/** One line as it left a container. */
export interface LogLine {
  readonly stream: 'stdout' | 'stderr';
  readonly timestamp?: string;
  readonly message: string;
  readonly truncated?: boolean;
}

/** The options a caller may choose. Nothing outside this set reaches Docker. */
export interface LogQuery {
  readonly tail: number;
  readonly since?: string;
  readonly timestamps: boolean;
  readonly stdout: boolean;
  readonly stderr: boolean;
}

/** Where a running stream delivers. */
export interface LogSink {
  readonly open: (streamId: string) => void;
  readonly lines: (lines: readonly LogLine[]) => void;
  /** Lines that were lost, with where they were lost. Never silent. */
  readonly dropped: (count: number, where: 'agent' | 'server') => void;
  readonly close: (reason: string, code?: ErrorCode) => void;
  /**
   * How many bytes are waiting for the consumer.
   *
   * The stream is cancelled when this exceeds what the server will hold, so a
   * browser that stops reading cannot turn a chatty container into unbounded
   * memory here.
   */
  readonly buffered: () => number;
}

/** The largest tail a caller may ask for, matching the agent's own ceiling. */
export const MAX_TAIL = 5000;

interface Target {
  readonly containerId: string;
  readonly dockerId: string;
  readonly name: string;
  readonly hostId: string;
  readonly hostname: string;
}

interface Active {
  readonly streamId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly containerId: string;
  readonly startedAt: Date;
  readonly sessionId: string;
  handle?: StreamHandle;
  revalidation?: NodeJS.Timeout;
  lifetime?: NodeJS.Timeout;
  closed: boolean;
}

/**
 * Live container logs.
 *
 * A stream reads output and carries it outwards. There is no direction back:
 * the capability it dispatches has no field an input could travel in, and the
 * agent exposes no Docker API that would accept one.
 *
 * Log content is treated as sensitive throughout. Dockplane cannot know what an
 * application prints, and applications print credentials and personal data, so
 * a line is delivered to the caller that holds the permission and written
 * nowhere else — not to the database, not to the audit trail, not to this
 * server's own log.
 */
@Injectable()
export class LogStreamService implements OnApplicationShutdown {
  private readonly active = new Map<string, Active>();

  constructor(
    private readonly db: Database,
    private readonly dispatch: AgentDispatchService,
    private readonly connections: AgentConnectionManager,
    private readonly sessions: SessionService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Streams running now, used by tests and diagnostics. */
  get runningCount(): number {
    return this.active.size;
  }

  /**
   * Reads what a container has already logged.
   *
   * A snapshot is a stream that does not follow: the agent sends the history
   * and ends. It is collected here under the same bounds a live stream has, so
   * a large tail cannot be turned into unbounded memory by asking for it as one
   * response.
   */
  async snapshot(
    containerId: string,
    query: LogQuery,
    actor: AuthenticatedUser,
    context: StreamContext,
  ): Promise<{ lines: readonly LogLine[]; dropped: number }> {
    const collected: LogLine[] = [];
    let dropped = 0;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = (error?: AppError) => {
        if (settled) {
          return;
        }

        settled = true;

        if (error) {
          reject(error);
          return;
        }

        resolve();
      };

      this.open(containerId, { ...query, follow: false }, actor, context, {
        open: () => undefined,
        lines: (lines) => {
          for (const line of lines) {
            if (collected.length < MAX_TAIL) {
              collected.push(line);
            } else {
              dropped += 1;
            }
          }
        },
        dropped: (count) => {
          dropped += count;
        },
        close: (_reason, code) => {
          finish(code ? new AppError(code, 'The logs could not be read.', 409) : undefined);
        },
        buffered: () => 0,
      }).catch((error: unknown) => finish(error as AppError));
    });

    return { lines: collected, dropped };
  }

  /**
   * Opens a stream and returns how to stop it.
   *
   * The caller stops it when the browser goes away. Everything else that ends a
   * stream — the agent disconnecting, the credential being revoked, the session
   * expiring, the permission being taken away, the lifetime running out — is
   * decided here, because none of it is something a browser would report.
   */
  async open(
    containerId: string,
    query: LogQuery & { follow: boolean },
    actor: AuthenticatedUser,
    context: StreamContext,
    sink: LogSink,
  ): Promise<() => void> {
    const target = await this.resolve(containerId);
    const agentId = await this.connectedAgent(target.hostId);

    this.enforceLimits(actor.id, agentId);

    const streamId = randomUUID();

    const stream: Active = {
      streamId,
      userId: actor.id,
      agentId,
      containerId: target.containerId,
      startedAt: new Date(),
      sessionId: context.sessionId,
      closed: false,
    };

    this.active.set(streamId, stream);

    /*
     * Ending is recorded before the caller is told.
     *
     * The trail is the only durable account of a stream, so it is written while
     * the stream still exists rather than after the response has gone. The
     * delay is one database write and it keeps opened and closed in order.
     */
    const finish = (reason: string, code?: ErrorCode) => {
      if (stream.closed) {
        return;
      }

      stream.closed = true;

      clearInterval(stream.revalidation);
      clearTimeout(stream.lifetime);
      this.active.delete(streamId);
      stream.handle?.cancel();

      void this.record('container.logs.closed', target, actor, context, streamId, reason).then(() =>
        sink.close(reason, code),
      );
    };

    /*
     * Opening is recorded before anything is dispatched, so a stream that
     * failed to start is still accounted for rather than absent from the trail.
     */
    await this.record('container.logs.opened', target, actor, context, streamId, 'opened');

    try {
      stream.handle = this.dispatch.openStream(
        agentId,
        'container.logs',
        {
          containerId: target.dockerId,
          tail: query.tail,
          since: query.since ?? '',
          timestamps: query.timestamps,
          stdout: query.stdout,
          stderr: query.stderr,
          follow: query.follow,
        },
        {
          started: () => sink.open(streamId),
          chunk: (payload, droppedByAgent) => {
            if (droppedByAgent > 0) {
              sink.dropped(droppedByAgent, 'agent');
            }

            const lines = readLines(payload);

            if (lines.length > 0) {
              sink.lines(lines);
            }

            /*
             * A consumer that stops reading is not made to wait: the stream
             * ends and says why. Holding the output would move the container's
             * whole log into this process's memory.
             */
            if (sink.buffered() > this.config.LOG_STREAM_MAX_BUFFERED_BYTES) {
              finish('overflow', 'LOG_STREAM_OVERFLOW');
            }
          },
          ended: (reason, error) => {
            finish(reason, error ? (agentEndCode(error.code) as ErrorCode) : undefined);
          },
        },
      );
    } catch (error) {
      this.active.delete(streamId);
      stream.closed = true;

      await this.record('container.logs.closed', target, actor, context, streamId, 'failed');

      throw error;
    }

    // The configured durations are seconds, as everywhere else in the schema.
    stream.revalidation = setInterval(() => {
      void this.revalidate(streamId, finish);
    }, this.config.LOG_STREAM_REVALIDATE_INTERVAL * 1000);

    stream.revalidation.unref?.();

    stream.lifetime = setTimeout(() => {
      finish('timeout', 'LOG_STREAM_TIMEOUT');
    }, this.config.LOG_STREAM_MAX_LIFETIME * 1000);

    stream.lifetime.unref?.();

    return () => finish('closed');
  }

  /** Ends every stream of an agent whose credential is no longer trusted. */
  endStreamsOfAgent(agentId: string, code: ErrorCode, message: string): number {
    this.dispatch.endStreamsOf(agentId, code, message);

    let ended = 0;

    for (const stream of [...this.active.values()]) {
      if (stream.agentId === agentId) {
        stream.handle?.cancel();
        ended += 1;
      }
    }

    return ended;
  }

  onApplicationShutdown(): void {
    for (const stream of [...this.active.values()]) {
      stream.handle?.cancel();
      clearInterval(stream.revalidation);
      clearTimeout(stream.lifetime);
    }

    this.active.clear();
  }

  /**
   * Re-checks that a running stream is still allowed to run.
   *
   * Authorization at the moment a stream opens is not enough: a stream lives
   * for minutes, and a session can be revoked, a user deactivated, a permission
   * withdrawn or an agent revoked while it runs. None of that reaches the
   * browser, so the server asks again on an interval.
   */
  private async revalidate(streamId: string, finish: (reason: string, code?: ErrorCode) => void) {
    const stream = this.active.get(streamId);

    if (!stream || stream.closed) {
      return;
    }

    try {
      if (!(await this.sessions.isActive(stream.sessionId))) {
        finish('session_ended', 'SESSION_EXPIRED');
        return;
      }

      const authorization = await this.rbac.authorizationFor(stream.userId);

      if (!authorization.permissions.has('containers.logs')) {
        finish('permission_withdrawn', 'PERMISSION_DENIED');
        return;
      }

      const [agent] = await this.db.client
        .select({ revokedAt: agents.revokedAt })
        .from(agents)
        .where(eq(agents.id, stream.agentId));

      if (!agent || agent.revokedAt) {
        finish('agent_revoked', 'AGENT_REVOKED');
        return;
      }

      if (!this.connections.isConnected(stream.agentId)) {
        finish('agent_disconnected', 'AGENT_OFFLINE');
      }
    } catch (error) {
      // A check that could not be made is not a permission to continue.
      this.logger.warn(
        {
          event: 'log_stream_revalidation_failed',
          streamId,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'a log stream could not be revalidated',
      );

      finish('revalidation_failed', 'LOG_STREAM_UNAVAILABLE');
    }
  }

  /**
   * Refuses a stream that would exceed a limit.
   *
   * Three ceilings, because they protect different things: one operator cannot
   * take the whole server, one host cannot be asked for more readers than it
   * should carry, and the process as a whole has a bound.
   */
  private enforceLimits(userId: string, agentId: string): void {
    let forUser = 0;
    let forAgent = 0;

    for (const stream of this.active.values()) {
      if (stream.userId === userId) {
        forUser += 1;
      }

      if (stream.agentId === agentId) {
        forAgent += 1;
      }
    }

    if (this.active.size >= this.config.LOG_STREAM_MAX_TOTAL) {
      throw limitReached('The control server is already carrying as many log streams as it may.');
    }

    if (forUser >= this.config.LOG_STREAM_MAX_PER_USER) {
      throw limitReached('You already have as many log streams open as you may.');
    }

    if (forAgent >= this.config.LOG_STREAM_MAX_PER_AGENT) {
      throw limitReached('This host is already serving as many log streams as it may.');
    }
  }

  /**
   * Records that a stream was opened or closed, and nothing about its content.
   *
   * The audit trail says who read which container's logs, on which host, and
   * when it ended. A log line never reaches it: the trail is read by people who
   * may not hold the permission that let the stream exist.
   */
  private async record(
    action: 'container.logs.opened' | 'container.logs.closed',
    target: Target,
    actor: AuthenticatedUser,
    context: StreamContext,
    streamId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.audit.record({
        action,
        result: reason === 'failed' || reason === 'overflow' ? 'failure' : 'success',
        actorUserId: actor.id,
        actorLabel: actor.email,
        targetType: 'container',
        targetId: target.containerId,
        targetLabel: target.name,
        reasonCode: `${streamId}:${reason}`,
        sourceIp: context.sourceIp,
        userAgent: context.userAgent,
      });
    } catch (error) {
      this.logger.warn(
        {
          event: 'log_stream_not_audited',
          streamId,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'a log stream could not be recorded',
      );
    }
  }

  /** Resolves the container the caller named into what the agent needs. */
  private async resolve(containerId: string): Promise<Target> {
    const [row] = await this.db.client
      .select({
        containerId: containers.id,
        dockerId: containers.dockerId,
        name: containers.name,
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

  /** Finds the agent that may read this host, refusing anything else. */
  private async connectedAgent(hostId: string): Promise<string> {
    const [agent] = await this.db.client
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.hostId, hostId), isNull(agents.revokedAt)));

    if (!agent) {
      throw AppError.conflict('AGENT_REVOKED', 'This host has no agent that may be reached.');
    }

    if (!this.connections.isConnected(agent.id)) {
      throw AppError.conflict('AGENT_OFFLINE', 'The agent is not connected.');
    }

    return agent.id;
  }
}

/** Where a stream came from, for the audit trail. */
export interface StreamContext {
  readonly sessionId: string;
  readonly sourceIp?: string;
  readonly userAgent?: string;
}

function limitReached(message: string): AppError {
  return AppError.conflict('LOG_STREAM_LIMIT_REACHED', message);
}

/**
 * Reads the lines out of a chunk, keeping only the fields the product defines.
 *
 * The payload comes from a host. Rebuilding it field by field means an agent
 * that reported more than it should — because it was modified, or compromised —
 * cannot put anything extra in front of an operator.
 */
function readLines(payload: unknown): LogLine[] {
  if (typeof payload !== 'object' || payload === null) {
    return [];
  }

  const lines = (payload as { lines?: unknown }).lines;

  if (!Array.isArray(lines)) {
    return [];
  }

  const result: LogLine[] = [];

  for (const entry of lines) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }

    const line = entry as Record<string, unknown>;
    const stream = line.stream === 'stderr' ? 'stderr' : 'stdout';

    result.push({
      stream,
      timestamp: typeof line.timestamp === 'string' ? line.timestamp : undefined,
      message: typeof line.message === 'string' ? line.message : '',
      truncated: line.truncated === true ? true : undefined,
    });
  }

  return result;
}

/** Maps what an agent reported onto the stable code a browser is given. */
function agentEndCode(code: string): string {
  switch (code) {
    case 'CONTAINER_NOT_FOUND':
      return 'CONTAINER_NOT_FOUND';
    case 'DOCKER_UNAVAILABLE':
    case 'DOCKER_PERMISSION_DENIED':
      return 'LOG_STREAM_UNAVAILABLE';
    case 'AGENT_CAPABILITY_UNSUPPORTED':
      return 'CAPABILITY_UNSUPPORTED';
    case 'AGENT_NOT_CONNECTED':
      return 'AGENT_OFFLINE';
    case 'AGENT_REQUEST_EXPIRED':
      return 'LOG_STREAM_TIMEOUT';
    default:
      return 'LOG_STREAM_UNAVAILABLE';
  }
}
