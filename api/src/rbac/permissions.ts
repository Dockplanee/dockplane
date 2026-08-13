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
 * `stacks.secrets.reveal` is separate from every other stack permission for the
 * same reason `containers.logs` is separate from `containers.read`. Being able
 * to change a stack's configuration is a different question from being able to
 * read the credentials it was configured with, and one does not imply the
 * other.
 *
 * `stacks.adopt` is separate from `stacks.create` because adopting changes who
 * is responsible for something that already exists and is already running.
 */
export const PERMISSIONS = {
  'hosts.read': 'View Docker hosts and their reported state',
  'containers.read': 'View discovered containers',
  'containers.start': 'Start a container',
  'containers.stop': 'Stop a container',
  'containers.restart': 'Restart a container',
  'containers.logs': 'Read and follow container logs',
  'containers.create': 'Create a container',
  'containers.update': 'Change a container’s configuration, which recreates it',
  'containers.delete': 'Remove a container',
  'compose.read': 'View discovered Compose projects',
  'stacks.read': 'View stacks and their revisions',
  'stacks.create': 'Create a stack',
  'stacks.update': 'Change a stack’s Compose source or environment',
  'stacks.deploy': 'Deploy, redeploy, start, stop or restart a stack',
  'stacks.delete': 'Remove a stack',
  'stacks.adopt': 'Take an existing Compose project under Dockplane’s management',
  'stacks.secrets.reveal': 'Read the value of a stack secret',
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

const READ_ONLY: Permission[] = ['hosts.read', 'containers.read', 'compose.read', 'stacks.read'];

/*
 * Operator carries restart but not stop.
 *
 * Restarting a stuck service is day-to-day work; taking one down and leaving it
 * down is a decision with a different weight. Whoever needs both gets both, by
 * a deliberate grant rather than by inheriting it.
 */
/*
 * Operator sees stacks and does not deploy them.
 *
 * For the same reason it carries restart and not stop: deploying changes what a
 * host runs, and whoever should be able to do that gets it by a deliberate
 * grant rather than by being an operator.
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
