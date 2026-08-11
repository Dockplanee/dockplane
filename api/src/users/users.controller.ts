import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { AppError } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuditService } from '../audit/audit.service';
import { Database } from '../database/database';
import { permissions, rolePermissions, roles, users } from '../database/schema';
import { AuthenticatedRequest, AuthenticatedUser } from '../auth/authenticated-request';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { RbacService } from '../rbac/rbac.service';

const assignRoleSchema = z.object({ role: z.string().min(1).max(64) });

@Controller('api/v1/users')
export class UsersController {
  constructor(
    private readonly db: Database,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('users.read')
  async list() {
    const rows = await this.db.client
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        isActive: users.isActive,
        mfaEnabled: users.mfaEnabled,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(users.email);

    // The password hash and MFA secret are never part of a response.
    return { users: rows };
  }

  @Post(':id/roles')
  @RequirePermissions('users.manage')
  async assignRole(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignRoleSchema)) body: z.infer<typeof assignRoleSchema>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const [target] = await this.db.client
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    if (!target) {
      throw AppError.notFound('USER_NOT_FOUND', 'The user does not exist.');
    }

    try {
      await this.rbac.assignRoleByName(id, body.role);
    } catch {
      throw AppError.notFound('ROLE_NOT_FOUND', 'The role does not exist.');
    }

    await this.audit.record({
      action: 'role.assigned',
      result: 'success',
      actorUserId: actor.id,
      actorLabel: actor.email,
      targetType: 'user',
      targetId: id,
      targetLabel: target.email,
      reasonCode: body.role,
      sourceIp: request.ip,
      userAgent: request.header('user-agent'),
    });

    return { status: 'assigned' as const };
  }
}

@Controller('api/v1/roles')
export class RolesController {
  constructor(private readonly db: Database) {}

  @Get()
  @RequirePermissions('roles.read')
  async list() {
    const rows = await this.db.client
      .select({
        id: roles.id,
        name: roles.name,
        description: roles.description,
        isBuiltIn: roles.isBuiltIn,
        permission: permissions.key,
      })
      .from(roles)
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .orderBy(roles.name);

    const byRole = new Map<
      string,
      { id: string; name: string; description: string; isBuiltIn: boolean; permissions: string[] }
    >();

    for (const row of rows) {
      const entry = byRole.get(row.id) ?? {
        id: row.id,
        name: row.name,
        description: row.description,
        isBuiltIn: row.isBuiltIn,
        permissions: [],
      };

      if (row.permission) {
        entry.permissions.push(row.permission);
      }

      byRole.set(row.id, entry);
    }

    return { roles: [...byRole.values()] };
  }
}
