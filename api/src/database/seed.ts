import { eq, notInArray } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { BUILT_IN_ROLES, PERMISSIONS, PERMISSION_KEYS } from '../rbac/permissions';
import { permissions, rolePermissions, roles } from './schema';

export interface SeedSummary {
  readonly permissions: number;
  readonly roles: number;
}

/**
 * Brings the permission catalog and built-in roles in line with the code.
 *
 * Idempotent, and run on every migration so a release that adds a permission
 * does not need a hand-written data migration. It never creates users: a
 * privileged account only ever comes from the explicit bootstrap command.
 */
export async function seedAuthorizationCatalog(
  db: NodePgDatabase<Record<string, never>>,
): Promise<SeedSummary> {
  return db.transaction(async (tx) => {
    for (const key of PERMISSION_KEYS) {
      await tx
        .insert(permissions)
        .values({ key, description: PERMISSIONS[key] })
        .onConflictDoUpdate({
          target: permissions.key,
          set: { description: PERMISSIONS[key] },
        });
    }

    // A permission dropped from the catalog must not linger as a grantable row.
    await tx.delete(permissions).where(notInArray(permissions.key, PERMISSION_KEYS));

    const catalog = await tx.select().from(permissions);
    const byKey = new Map(catalog.map((entry) => [entry.key, entry.id]));

    for (const role of BUILT_IN_ROLES) {
      const [existing] = await tx.select().from(roles).where(eq(roles.name, role.name)).limit(1);

      const roleId =
        existing?.id ??
        (
          await tx
            .insert(roles)
            .values({ name: role.name, description: role.description, isBuiltIn: true })
            .returning({ id: roles.id })
        )[0].id;

      if (existing) {
        await tx
          .update(roles)
          .set({ description: role.description, isBuiltIn: true, updatedAt: new Date() })
          .where(eq(roles.id, roleId));
      }

      // Built-in role membership is defined by code, so it is replaced wholesale.
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));

      const grants = role.permissions
        .map((key) => byKey.get(key))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId, permissionId }));

      if (grants.length > 0) {
        await tx.insert(rolePermissions).values(grants);
      }
    }

    return { permissions: PERMISSION_KEYS.length, roles: BUILT_IN_ROLES.length };
  });
}
