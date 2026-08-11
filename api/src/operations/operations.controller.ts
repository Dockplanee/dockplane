import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AuthenticatedRequest, AuthenticatedUser } from '../auth/authenticated-request';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { Database } from '../database/database';
import { actions, containers, hosts, users } from '../database/schema';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { LifecycleService } from './lifecycle.service';

const idSchema = z.uuid();

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function context(request: AuthenticatedRequest) {
  return {
    sourceIp: request.ip,
    userAgent: request.header('user-agent'),
    requestId: request.header('x-request-id') ?? undefined,
  };
}

/**
 * Container lifecycle.
 *
 * One route per operation, deliberately. A single endpoint taking an operation
 * name would make the set of things Dockplane can do to a host a property of
 * the request body rather than of the code, and every future capability would
 * arrive already reachable.
 *
 * A caller names a container and nothing else. The host, the agent and the
 * Docker identifier are derived by the server, so the browser never chooses
 * which machine an operation lands on.
 */
@Controller('api/v1/containers')
export class ContainerOperationsController {
  constructor(private readonly lifecycle: LifecycleService) {}

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('containers.start')
  async start(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.lifecycle.run('start', id, user, context(request));
  }

  @Post(':id/stop')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('containers.stop')
  async stop(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.lifecycle.run('stop', id, user, context(request));
  }

  @Post(':id/restart')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('containers.restart')
  async restart(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.lifecycle.run('restart', id, user, context(request));
  }
}

/**
 * What Dockplane has been asked to do.
 *
 * Read-only, and separate from the audit trail: audit answers who did what to
 * the system, this answers what happened to a container and how long it took.
 */
@Controller('api/v1/actions')
export class ActionsController {
  constructor(private readonly db: Database) {}

  @Get()
  @RequirePermissions('containers.read')
  async list(@Query(new ZodValidationPipe(pageSchema)) query: z.infer<typeof pageSchema>) {
    const rows = await this.db.client
      .select({
        id: actions.id,
        capability: actions.capability,
        status: actions.status,
        requestedAt: actions.requestedAt,
        startedAt: actions.startedAt,
        completedAt: actions.completedAt,
        errorCode: actions.errorCode,
        correlationId: actions.correlationId,
        targetId: actions.targetId,
        containerName: containers.name,
        hostname: hosts.hostname,
        actor: users.email,
      })
      .from(actions)
      /*
       * The target is text, because an action can point at things that are not
       * containers. The container identifier is cast to match rather than the
       * other way round: casting the column would fail on the first row whose
       * target is not a UUID.
       */
      .leftJoin(containers, eq(sql`${containers.id}::text`, actions.targetId))
      .leftJoin(hosts, eq(hosts.id, actions.hostId))
      .leftJoin(users, eq(users.id, actions.actorUserId))
      .orderBy(desc(actions.requestedAt))
      .limit(query.limit)
      .offset(query.offset);

    return {
      actions: rows.map((row) => ({
        ...row,
        // A container that has since been removed still has a history; its name
        // is what the record kept, and its absence is not an error.
        containerName: row.containerName ?? row.targetId,
        durationMs:
          row.completedAt && row.startedAt
            ? row.completedAt.getTime() - row.startedAt.getTime()
            : undefined,
      })),
      page: { limit: query.limit, offset: query.offset },
    };
  }
}
