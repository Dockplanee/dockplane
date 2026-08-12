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
    ],
  },
  {
    id: 'containers',
    index: '02',
    title: 'Containers',
    summary: 'Inspect a workload and its context, then use a defined lifecycle action.',
    entries: [
      {
        name: 'Container list',
        detail: 'Containers across all connected hosts, filtered by host or group.',
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
        name: 'Lifecycle actions',
        detail: 'Start, stop and restart through validated agent capabilities.',
      },
    ],
  },
  {
    id: 'compose',
    index: '03',
    title: 'Compose',
    summary: 'Applications stay grouped instead of dissolving into an unrelated container list.',
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
    ],
  },
  {
    id: 'operations',
    index: '04',
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
    id: 'administration',
    index: '05',
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
