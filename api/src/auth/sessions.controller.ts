import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { AppError } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuditService } from '../audit/audit.service';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { AuthenticatedRequest, AuthenticatedUser } from './authenticated-request';
import { CurrentSession, CurrentUser } from './current-user.decorator';
import { ActiveSession, SessionService } from './session.service';

const listQuery = z.object({ userId: z.uuid().optional() });

@Controller('api/v1/sessions')
export class SessionsController {
  constructor(
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lists sessions.
   *
   * An operator always sees their own. Reading someone else's requires
   * `sessions.read`, so the query parameter cannot be used to browse other
   * accounts.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(listQuery)) query: z.infer<typeof listQuery>,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentSession() session: ActiveSession,
  ) {
    const targetUserId = query.userId ?? user.id;

    if (targetUserId !== user.id && !user.permissions.has('sessions.read')) {
      throw AppError.forbidden(
        'PERMISSION_DENIED',
        'You do not have permission to perform this action.',
      );
    }

    const rows = await this.sessions.listForUser(targetUserId);

    // Metadata only. A token digest is of no use to a client and is not returned.
    return {
      sessions: rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        userAgent: row.userAgent,
        sourceIp: row.sourceIp,
        current: row.id === session.id,
      })),
    };
  }

  /** Revokes a session. Someone else's requires `sessions.revoke`. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const target = await this.sessions.findById(id);

    if (!target) {
      throw AppError.notFound('SESSION_REVOKED', 'The session does not exist.');
    }

    if (target.userId !== user.id && !user.permissions.has('sessions.revoke')) {
      throw AppError.forbidden(
        'PERMISSION_DENIED',
        'You do not have permission to perform this action.',
      );
    }

    await this.sessions.revoke(id);

    await this.audit.record({
      action: 'session.revoked',
      result: 'success',
      actorUserId: user.id,
      actorLabel: user.email,
      targetType: 'session',
      targetId: id,
      reasonCode: target.userId === user.id ? 'self' : 'administrative',
      sourceIp: request.ip,
      userAgent: request.header('user-agent'),
    });
  }
}

/** Administrative listing across accounts, kept separate from the self-service route. */
@Controller('api/v1/admin/sessions')
export class AdminSessionsController {
  constructor(private readonly sessions: SessionService) {}

  @Get(':userId')
  @RequirePermissions('sessions.read')
  async listForUser(@Param('userId') userId: string) {
    const rows = await this.sessions.listForUser(userId);

    return {
      sessions: rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        userAgent: row.userAgent,
        sourceIp: row.sourceIp,
      })),
    };
  }
}
