import { IconName } from '../ui/icon/icon';
import { Permission } from './permissions';

export interface NavItem {
  readonly label: string;
  readonly path: string;
  readonly icon: IconName;
  /**
   * Item is offered only when the operator holds this permission.
   *
   * Absent for an area every signed-in operator may reach, such as their own
   * settings.
   */
  readonly permission?: Permission;
}

export interface NavGroup {
  /** Absent for the leading ungrouped entry. */
  readonly title?: string;
  readonly items: readonly NavItem[];
}

/**
 * Sidebar structure from docs/design/APP_UI_SPEC.md.
 *
 * Every entry resolves to a route that exists and is gated on a permission the
 * control server actually issues. Images, volumes, networks and operational
 * events are absent: the server does not serve them, and a navigation entry
 * leading to an empty page is worse than none.
 */
export const NAVIGATION: readonly NavGroup[] = [
  {
    items: [{ label: 'Overview', path: '/overview', icon: 'overview', permission: 'hosts.read' }],
  },
  {
    title: 'Docker',
    items: [
      { label: 'Hosts', path: '/hosts', icon: 'hosts', permission: 'hosts.read' },
      {
        label: 'Containers',
        path: '/containers',
        icon: 'containers',
        permission: 'containers.read',
      },
      { label: 'Stacks', path: '/stacks', icon: 'compose', permission: 'stacks.read' },
      /*
       * Compose projects found on a host, which Dockplane did not create and
       * does not deploy. A separate entry from Stacks on purpose: the two look
       * alike and the difference — who is responsible for the configuration —
       * is the whole point.
       */
      { label: 'Compose', path: '/compose', icon: 'compose', permission: 'compose.read' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { label: 'Health', path: '/health', icon: 'health', permission: 'hosts.read' },
      { label: 'Actions', path: '/actions', icon: 'actions', permission: 'containers.read' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { label: 'Agents', path: '/agents', icon: 'agents', permission: 'agents.read' },
      { label: 'Users', path: '/users', icon: 'users', permission: 'users.read' },
      { label: 'Roles', path: '/roles', icon: 'roles', permission: 'roles.read' },
      { label: 'Audit Log', path: '/audit', icon: 'audit', permission: 'audit.read' },
      { label: 'Settings', path: '/settings', icon: 'settings' },
    ],
  },
];
