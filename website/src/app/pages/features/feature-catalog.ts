/**
 * Capability catalogue for the features page.
 *
 * The areas and their entries follow docs/product/PRODUCT_SCOPE.md. Anything
 * that is not part of the defined scope belongs in `PLANNED` or `OUT_OF_SCOPE`
 * so the page never presents a direction as an available capability.
 */

export interface FeatureArea {
  readonly id: string;
  readonly index: string;
  readonly title: string;
  readonly summary: string;
  readonly entries: readonly FeatureEntry[];
}

export interface FeatureEntry {
  readonly name: string;
  readonly detail: string;
}

export const FEATURE_AREAS: readonly FeatureArea[] = [
  {
    id: 'hosts',
    index: '01',
    title: 'Hosts',
    summary: 'Every connected Docker host in one inventory, with the state you need before acting.',
    entries: [
      {
        name: 'Host inventory',
        detail: 'Hostname, operating system and Docker Engine version per connected host.',
      },
      {
        name: 'Connectivity state',
        detail: 'Online, offline and stale state, shown as state rather than as silence.',
      },
      { name: 'Host metrics', detail: 'CPU, memory and disk signals for the host itself.' },
      {
        name: 'Workload counts',
        detail: 'How many containers and Compose projects a host is carrying.',
      },
      {
        name: 'Agent state',
        detail: 'Whether the agent is connected and which protocol version it reports.',
      },
      {
        name: 'Archiving',
        detail:
          'A host that has been replaced leaves the working lists and keeps everything it carried. Reversible, and not a delete: no host record is removed and none is merged with another.',
      },
    ],
  },
  {
    id: 'containers',
    index: '02',
    title: 'Containers',
    summary:
      'Every container on a connected host can be read and run. The ones Dockplane created can also be changed.',
    entries: [
      {
        name: 'Container list',
        detail: 'Containers across all connected hosts, filtered by host.',
      },
      {
        name: 'Inspect',
        detail: 'Image, configuration, ports, mounts and labels for a single container.',
      },
      { name: 'Health state', detail: 'Configured health checks and their most recent result.' },
      {
        name: 'Logs',
        detail: 'Container log output with a timestamp column and horizontal scrolling.',
      },
      {
        name: 'Run state',
        detail: 'Start, stop and restart any discovered container, through validated capabilities.',
      },
      {
        name: 'Create a container',
        detail: 'Image, ports, mounts, environment and restart policy, from a typed specification.',
      },
      {
        name: 'Change a container',
        detail:
          'Editing replaces the container and keeps its identity and history. Volumes are never removed.',
      },
      {
        name: 'Remove a container',
        detail:
          'Available for containers Dockplane created. A discovered one keeps a read-only configuration.',
      },
    ],
  },
  {
    id: 'stacks',
    index: '03',
    title: 'Managed stacks',
    summary: 'A Compose file Dockplane holds, with its history, deployed to a host you choose.',
    entries: [
      {
        name: 'Saved configuration',
        detail: 'A Compose file and the environment it needs, stored with the stack.',
      },
      {
        name: 'Encrypted values',
        detail: 'A value marked secret is stored encrypted and never shown again.',
      },
      {
        name: 'Revisions',
        detail: 'Every saved configuration is kept, with the difference to the one before it.',
      },
      {
        name: 'Configuration rollback',
        detail:
          'Deploying an earlier revision is the rollback. It restores configuration, not volumes.',
      },
      {
        name: 'Deploy',
        detail:
          'The control server resolves the plan; the agent applies it and reports the result.',
      },
      {
        name: 'Stack lifecycle',
        detail: 'Start, stop, restart and delete a deployed stack as one workload.',
      },
    ],
  },
  {
    id: 'compose',
    index: '04',
    title: 'Compose projects found on a host',
    summary:
      'Projects Dockplane did not deploy are discovered and read, so applications stay grouped.',
    entries: [
      { name: 'Project discovery', detail: 'Compose projects found on each connected host.' },
      {
        name: 'Project membership',
        detail: 'Which containers belong to a project, and which do not belong to any.',
      },
      { name: 'Project state', detail: 'Aggregated state across the containers of a project.' },
      {
        name: 'Project inspection',
        detail: 'Labels and discovered configuration metadata where safely available.',
      },
      {
        name: 'Read-only',
        detail:
          'A discovered project is not deployed, changed or removed. Taking one over is not part of this release.',
      },
    ],
  },
  {
    id: 'versions',
    index: '05',
    title: 'Versions',
    summary: 'What a deployment is running, and the one request it makes only if you ask it to.',
    entries: [
      {
        name: 'Component versions',
        detail:
          'The control server and the browser application report their own release and commit.',
      },
      {
        name: 'Agent versions',
        detail: 'What every enrolled agent reports, and the protocol range the server accepts.',
      },
      {
        name: 'Mixed versions',
        detail: 'A fleet part-way through a rollout is marked as mixed rather than as broken.',
      },
      {
        name: 'Unknown and unsupported',
        detail:
          'An agent outside the accepted protocol range is an error; one that reports nothing readable is counted as unknown.',
      },
      {
        name: 'Optional update check',
        detail:
          'Dockplane can ask the public release listing whether something newer exists. It is off until an administrator turns it on, and nothing acts on the answer.',
      },
    ],
  },
  {
    id: 'operations',
    index: '06',
    title: 'Operational context',
    summary:
      'What happened, what it affected and whether the action you requested actually succeeded.',
    entries: [
      { name: 'Normalized events', detail: 'Operational events in one shape across hosts.' },
      {
        name: 'Action history',
        detail: 'Requested, authorized, dispatched, succeeded, failed and timed-out actions.',
      },
      {
        name: 'Correlation IDs',
        detail:
          'A request identifier that ties the interface, API, agent and audit entry together.',
      },
      {
        name: 'Stale-state indicators',
        detail: 'Data that is no longer current is marked instead of being presented as live.',
      },
    ],
  },
  {
    id: 'interface',
    index: '07',
    title: 'The interface',
    summary: 'An operational surface that stays usable at the width it is given.',
    entries: [
      {
        name: 'Tables that fit the window',
        detail:
          'A full table where everything fits, a compact one that keeps what somebody needs to act, and a stacked list below a tablet width.',
      },
      {
        name: 'What is always in view',
        detail:
          'What a thing is, which host it belongs to, what state it is in, and the way to act on it — at every width.',
      },
      {
        name: 'Controls that can be hit',
        detail: 'Interactive targets sized against WCAG 2.2 AA rather than against a mouse.',
      },
    ],
  },
  {
    id: 'administration',
    index: '08',
    title: 'Security and administration',
    summary: 'Who may do what, on which resources, and what was recorded about it.',
    entries: [
      {
        name: 'Local user accounts',
        detail: 'Accounts with modern password hashing and secure password reset.',
      },
      {
        name: 'MFA and recovery codes',
        detail: 'Time-based one-time passwords with recovery codes.',
      },
      { name: 'Sessions', detail: 'Visibility over active sessions, with revocation.' },
      {
        name: 'Roles and permissions',
        detail: 'Named permission collections enforced by the backend.',
      },
      {
        name: 'Agent enrollment',
        detail: 'Short-lived enrollment tokens exchanged for a device-specific identity.',
      },
      {
        name: 'Agent revocation',
        detail: 'Individual revocation without replacing credentials across the fleet.',
      },
      {
        name: 'Audit history',
        detail: 'Actor, action, target, result and request context for sensitive operations.',
      },
    ],
  },
];

export const PLANNED: readonly FeatureEntry[] = [
  {
    name: 'Images, networks and volumes',
    detail: 'Read the resources behind the workloads. Destructive operations stay withheld.',
  },
  {
    name: 'Container metrics',
    detail: 'CPU, memory and network usage per workload. Metrics are host-level today.',
  },
  {
    name: 'Host groups',
    detail: 'Group hosts for navigation, and scope permissions to a group.',
  },
  {
    name: 'Resource scopes',
    detail: 'Permissions that apply to a host, a group or a service rather than everything.',
  },
  {
    name: 'Image update detection',
    detail: 'Notice when a newer image is available for a running workload.',
  },
  {
    name: 'Controlled update workflows',
    detail: 'Apply an image update as a reviewed, auditable operation.',
  },
  {
    name: 'Backup and restore integration',
    detail: 'Coordinate backups around the workloads Dockplane already knows.',
  },
  { name: 'Notifications', detail: 'Route health and action outcomes to an external channel.' },
  {
    name: 'Maintenance windows',
    detail: 'Suppress alerting and guard operations during planned work.',
  },
  {
    name: 'Safe runbooks',
    detail: 'Repeatable operational procedures built from existing capabilities.',
  },
  {
    name: 'Service-level health',
    detail: 'Health rolled up to the application rather than the container.',
  },
];

export const OUT_OF_SCOPE: readonly string[] = [
  'Proxmox management',
  'Kubernetes management',
  'VM lifecycle management',
  'Pterodactyl panels',
  'General SSH fleet management',
  'Arbitrary shell orchestration',
  'Network-device management',
  'Generic cloud control plane functionality',
];
