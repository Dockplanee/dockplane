import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';

import { AuthenticatedRequest, AuthenticatedUser } from '../auth/authenticated-request';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AppError, ErrorCode } from '../common/errors';
import { AppConfig, CONFIG } from '../config/configuration';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { LogLine, LogQuery, LogStreamService, MAX_TAIL, StreamContext } from './log-stream.service';

const idSchema = z.uuid();

/**
 * The complete vocabulary of a log request.
 *
 * Every option is named and bounded here. Nothing is forwarded to the Docker
 * API because a caller asked for it: an option this schema does not define does
 * not exist as far as the agent is concerned.
 */
const querySchema = z.object({
  tail: z.coerce.number().int().min(0).max(MAX_TAIL).default(200),
  since: z.iso.datetime({ offset: true }).optional(),
  timestamps: z.stringbool().default(true),
  stdout: z.stringbool().default(true),
  stderr: z.stringbool().default(true),
});

type LogQueryInput = z.infer<typeof querySchema>;

function toQuery(query: LogQueryInput): LogQuery {
  if (!query.stdout && !query.stderr) {
    throw new AppError('VALIDATION_FAILED', 'Ask for stdout, stderr or both.');
  }

  return {
    tail: query.tail,
    since: query.since,
    timestamps: query.timestamps,
    stdout: query.stdout,
    stderr: query.stderr,
  };
}

function contextOf(request: AuthenticatedRequest): StreamContext {
  return {
    sessionId: request.authSession?.id ?? '',
    sourceIp: request.ip,
    userAgent: request.header('user-agent'),
  };
}

/**
 * Container logs.
 *
 * Two ways to read the same thing: a snapshot of what a container has already
 * printed, and a stream that starts with that history and then follows. Both
 * are read-only, both require `containers.logs`, and neither has a direction
 * back into the container.
 *
 * A caller names a container. The host, the agent and the Docker identifier are
 * derived by the server, so a browser cannot choose which machine is read or
 * which capability is dispatched.
 */
@Controller('api/v1/containers')
export class ContainerLogsController {
  constructor(
    private readonly logs: LogStreamService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get(':id/logs')
  @RequirePermissions('containers.logs')
  async snapshot(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Query(new ZodValidationPipe(querySchema)) query: LogQueryInput,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const result = await this.logs.snapshot(id, toQuery(query), user, contextOf(request));

    return {
      lines: result.lines,
      /*
       * What could not be delivered, so a viewer can say the log is incomplete
       * rather than presenting a gap as the whole story.
       */
      dropped: result.dropped,
    };
  }

  /**
   * Follows a container's output.
   *
   * Server-sent events: one direction, plain HTTP, the existing session cookie,
   * and no new transport to secure. A browser that goes away closes the
   * connection, which is what ends the stream and the Docker reader behind it.
   */
  @Get(':id/logs/stream')
  @RequirePermissions('containers.logs')
  async stream(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Query(new ZodValidationPipe(querySchema)) query: LogQueryInput,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    const options = toQuery(query);

    response.setHeader('content-type', 'text/event-stream');
    response.setHeader('cache-control', 'no-cache, no-store');
    response.setHeader('connection', 'keep-alive');
    // Buffering a stream defeats it; a proxy is told not to.
    response.setHeader('x-accel-buffering', 'no');
    response.flushHeaders();

    const send = (event: string, data: unknown) => {
      if (!response.writableEnded) {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    let stop: (() => void) | undefined;

    /*
     * A comment every so often, so a quiet container does not look like an idle
     * connection to whatever sits between the browser and here.
     *
     * A comment rather than an event: it is part of the event-stream format, it
     * carries nothing, and a client cannot mistake it for output. It keeps the
     * connection open and nothing else — the session, the permission and the
     * agent are re-checked on their own schedule, and a stream that has lost
     * any of them is ended there regardless of how healthy the socket looks.
     */
    const keepalive = setInterval(() => {
      if (!response.writableEnded) {
        response.write(': keepalive\n\n');
      }
    }, this.config.LOG_STREAM_KEEPALIVE_INTERVAL * 1000);

    keepalive.unref?.();

    const finish = () => {
      clearInterval(keepalive);

      if (!response.writableEnded) {
        response.end();
      }
    };

    /*
     * A browser that navigates away, closes the tab or aborts the request is
     * the ordinary way a stream ends. Nothing else tells the server, so the
     * closed connection is what stops the agent reading.
     */
    request.on('close', () => {
      stop?.();
      finish();
    });

    try {
      stop = await this.logs.open(id, { ...options, follow: true }, user, contextOf(request), {
        open: (streamId) => send('open', { streamId }),
        lines: (lines: readonly LogLine[]) => send('lines', { lines }),
        dropped: (count, where) => send('dropped', { count, where }),
        close: (reason, code) => {
          send('end', { reason, code });
          finish();
        },
        /*
         * What Node has accepted but not yet written. It is the only honest
         * measure of a consumer that has stopped reading, and it is what the
         * stream service watches to decide the connection has fallen behind.
         */
        buffered: () => response.writableLength,
      });
    } catch (error) {
      const problem = error instanceof AppError ? error : undefined;

      send('end', {
        reason: 'failed',
        code: (problem?.code ?? 'LOG_STREAM_UNAVAILABLE') satisfies string as ErrorCode,
      });

      finish();
    }
  }
}
