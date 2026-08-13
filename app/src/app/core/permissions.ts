import { Injectable, computed, inject } from '@angular/core';

import { Session } from './session';

/**
 * Permissions the control server issues.
 *
 * This list mirrors the server's catalog exactly. A key exists here only when
 * the backend enforces something with it, so the interface cannot offer an
 * action the server would refuse — and cannot hide behind a permission that is
 * never granted.
 *
 * These control what the interface *offers*. They are not access control: the
 * control server authorizes every request independently, and a hidden control
 * is never a security boundary.
 */
export const PERMISSIONS = [
  'hosts.read',
  'containers.read',
  'containers.start',
  'containers.stop',
  'containers.restart',
  'containers.logs',
  'containers.create',
  'containers.update',
  'containers.delete',
  'compose.read',
  'agents.read',
  'agents.enroll',
  'agents.revoke',
  'audit.read',
  'users.read',
  'users.manage',
  'roles.read',
  'roles.manage',
  'sessions.read',
  'sessions.revoke',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const KNOWN = new Set<string>(PERMISSIONS);

/** Keeps an unknown key the server may add from being treated as granted. */
export function toPermissions(values: readonly unknown[]): readonly Permission[] {
  return values.filter(
    (value): value is Permission => typeof value === 'string' && KNOWN.has(value),
  );
}

/**
 * What the signed-in operator may do.
 *
 * The set comes from the authenticated session and from nowhere else. There is
 * no development grant, no administrator fallback and no assumption on error:
 * an operator whose permissions could not be read holds none, so the interface
 * offers nothing rather than offering something the server will refuse.
 */
@Injectable({ providedIn: 'root' })
export class Permissions {
  private readonly session = inject(Session);

  private readonly granted = computed<ReadonlySet<Permission>>(
    () => new Set(this.session.permissions()),
  );

  readonly all = computed(() => [...this.granted()].sort());

  has(permission: Permission): boolean {
    return this.granted().has(permission);
  }

  hasAny(...permissions: readonly Permission[]): boolean {
    return permissions.some((permission) => this.has(permission));
  }
}
