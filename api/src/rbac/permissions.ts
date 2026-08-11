/**
 * Permission catalog.
 *
 * A permission exists here only when the control server actually enforces
 * something with it.
 *
 * `containers.logs` is sensitive in a way the others are not. Dockplane cannot
 * know what an application prints, and applications print credentials, tokens
 * and personal data. Granting it is granting whatever the workloads on a host
 * happen to write.
 *
 * The three lifecycle keys are deliberately separate. A single
 * `containers.manage` would be easier to grant and impossible to grant
 * carefully: an operator who should be able to restart a stuck service would
 * also be able to stop one for good.
 *
 */
export const PERMISSIONS = {
  'hosts.read': 'View Docker hosts and their reported state',
  'containers.read': 'View discovered containers',
  'containers.start': 'Start a container',
  'containers.stop': 'Stop a container',
  'containers.restart': 'Restart a container',
  'containers.logs': 'Read and follow container logs',
  'compose.read': 'View discovered Compose projects',
  'agents.read': 'View enrolled agents',
  'agents.enroll': 'Create agent enrollment tokens',
  'agents.revoke': 'Revoke an agent credential',
  'audit.read': 'Read the audit log',
  'users.read': 'View users',
  'users.manage': 'Create, modify and deactivate users',
  'roles.read': 'View roles and their permissions',
  'roles.manage': 'Create and modify roles',
  'sessions.read': 'View active sessions',
  'sessions.revoke': 'Revoke sessions',
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

const READ_ONLY: Permission[] = ['hosts.read', 'containers.read', 'compose.read'];

/*
 * Operator carries restart but not stop.
 *
 * Restarting a stuck service is day-to-day work; taking one down and leaving it
 * down is a decision with a different weight. Whoever needs both gets both, by
 * a deliberate grant rather than by inheriting it.
 */
const OPERATOR: Permission[] = [
  ...READ_ONLY,
  'containers.restart',
  'containers.logs',
  'agents.read',
  'audit.read',
];

/** Built-in roles. */
export const BUILT_IN_ROLES = [
  {
    name: 'Administrator',
    description: 'Full access including user, role and agent administration.',
    permissions: PERMISSION_KEYS,
  },
  {
    name: 'Operator',
    description: 'Day-to-day visibility into hosts, workloads, agents and the audit log.',
    permissions: OPERATOR,
  },
  {
    name: 'Read Only',
    description: 'Read-only visibility into hosts and workloads.',
    permissions: READ_ONLY,
  },
] as const;

export type BuiltInRoleName = (typeof BUILT_IN_ROLES)[number]['name'];
