import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { Database } from '../database/database';
import { permissions, rolePermissions, roles, userRoles } from '../database/schema';
import { PERMISSION_KEYS, Permission } from './permissions';

export interface UserAuthorization {
  readonly roles: readonly string[];
  readonly permissions: ReadonlySet<Permission>;
}

/**
 * Resolves what a user is allowed to do.
 *
 * Authority comes only from role assignments in the database. There is no
 * fallback that treats an unknown or unassigned user as privileged: a user
 * without roles resolves to an empty permission set and is denied everywhere.
 */
@Injectable()
export class RbacService {
  constructor(private readonly db: Database) {}

  async authorizationFor(userId: string): Promise<UserAuthorization> {
    const rows = await this.db.client
      .select({ role: roles.name, permission: permissions.key })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(userRoles.userId, userId));

    const roleNames = new Set<string>();
    const granted = new Set<Permission>();

    for (const row of rows) {
      roleNames.add(row.role);

      // A key that is no longer in the catalog grants nothing.
      if (row.permission && isKnownPermission(row.permission)) {
        granted.add(row.permission);
      }
    }

    return { roles: [...roleNames].sort(), permissions: granted };
  }

  async assignRoleByName(userId: string, roleName: string): Promise<void> {
    const [role] = await this.db.client
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, roleName))
      .limit(1);

    if (!role) {
      throw new Error(`Role ${roleName} does not exist`);
    }

    await this.db.client
      .insert(userRoles)
      .values({ userId, roleId: role.id })
      .onConflictDoNothing();
  }
}

const KNOWN = new Set<string>(PERMISSION_KEYS);

function isKnownPermission(key: string): key is Permission {
  return KNOWN.has(key);
}
