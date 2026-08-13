import { Routes } from '@angular/router';

import {
  confirmDiscard,
  requiresAnonymous,
  requiresPermission,
  requiresSession,
} from './core/guards';

/**
 * Every route here resolves to a view backed by a real endpoint.
 *
 * Areas the control server does not serve — images, volumes, networks and
 * operational events — have no route at all. A route rendering an empty page
 * would suggest the feature exists and is broken, rather than that it has not
 * been built.
 *
 * Protection is applied here rather than inside views: a guard runs before the
 * component is created, so protected content is never rendered for the moment
 * before an answer arrives.
 */
export const routes: Routes = [
  {
    path: 'login',
    canActivate: [requiresAnonymous],
    loadComponent: () => import('./features/auth/login').then((m) => m.Login),
  },
  {
    path: 'forbidden',
    canActivate: [requiresSession],
    loadComponent: () => import('./features/auth/forbidden').then((m) => m.Forbidden),
  },

  { path: '', pathMatch: 'full', redirectTo: 'overview' },

  {
    path: 'overview',
    canActivate: [requiresPermission('hosts.read')],
    loadComponent: () => import('./features/overview/overview').then((m) => m.Overview),
  },

  {
    path: 'hosts',
    canActivate: [requiresPermission('hosts.read')],
    loadComponent: () => import('./features/hosts/host-list').then((m) => m.HostList),
  },
  {
    path: 'hosts/:id',
    canActivate: [requiresPermission('hosts.read')],
    loadComponent: () => import('./features/hosts/host-detail').then((m) => m.HostDetail),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      {
        path: 'overview',
        loadComponent: () =>
          import('./features/hosts/host-overview-tab').then((m) => m.HostOverviewTab),
      },
      {
        path: 'containers',
        loadComponent: () =>
          import('./features/hosts/host-containers-tab').then((m) => m.HostContainersTab),
      },
      {
        path: 'compose',
        loadComponent: () =>
          import('./features/hosts/host-compose-tab').then((m) => m.HostComposeTab),
      },
    ],
  },

  {
    path: 'containers',
    canActivate: [requiresPermission('containers.read')],
    loadComponent: () =>
      import('./features/containers/container-list').then((m) => m.ContainerList),
  },
  /*
   * Before `containers/:id`, or the router would read `new` as an identifier
   * and try to load a container by that name.
   */
  {
    path: 'containers/new',
    canActivate: [requiresPermission('containers.create')],
    loadComponent: () =>
      import('./features/containers/container-create').then((m) => m.ContainerCreate),
  },
  {
    path: 'containers/:id/edit',
    canActivate: [requiresPermission('containers.update')],
    loadComponent: () =>
      import('./features/containers/container-edit').then((m) => m.ContainerEdit),
  },
  {
    path: 'containers/:id',
    canActivate: [requiresPermission('containers.read')],
    loadComponent: () =>
      import('./features/containers/container-detail').then((m) => m.ContainerDetail),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      {
        path: 'overview',
        loadComponent: () =>
          import('./features/containers/container-overview-tab').then(
            (m) => m.ContainerOverviewTab,
          ),
      },
      {
        path: 'configuration',
        loadComponent: () =>
          import('./features/containers/container-configuration-tab').then(
            (m) => m.ContainerConfigurationTab,
          ),
      },
      {
        path: 'networks',
        loadComponent: () =>
          import('./features/containers/container-networks-tab').then(
            (m) => m.ContainerNetworksTab,
          ),
      },
      {
        path: 'volumes',
        loadComponent: () =>
          import('./features/containers/container-volumes-tab').then((m) => m.ContainerVolumesTab),
      },
      {
        path: 'logs',
        loadComponent: () =>
          import('./features/containers/container-logs-tab').then((m) => m.ContainerLogsTab),
      },
    ],
  },

  /*
   * Before `stacks/:id`, or the router would read `new` as an identifier and
   * try to load a stack by that name.
   */
  {
    path: 'stacks/new',
    canActivate: [requiresPermission('stacks.create')],
    canDeactivate: [confirmDiscard],
    loadComponent: () => import('./features/stacks/stack-create').then((m) => m.StackCreate),
  },
  {
    path: 'stacks/:id/edit',
    canActivate: [requiresPermission('stacks.update')],
    canDeactivate: [confirmDiscard],
    loadComponent: () => import('./features/stacks/stack-edit').then((m) => m.StackEdit),
  },
  {
    path: 'stacks',
    canActivate: [requiresPermission('stacks.read')],
    loadComponent: () => import('./features/stacks/stack-list').then((m) => m.StackList),
  },
  {
    path: 'stacks/:id',
    canActivate: [requiresPermission('stacks.read')],
    loadComponent: () => import('./features/stacks/stack-detail').then((m) => m.StackDetail),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      {
        path: 'overview',
        loadComponent: () =>
          import('./features/stacks/stack-overview-tab').then((m) => m.StackOverviewTab),
      },
      {
        path: 'revisions',
        loadComponent: () =>
          import('./features/stacks/stack-revisions-tab').then((m) => m.StackRevisionsTab),
      },
      {
        path: 'services',
        loadComponent: () =>
          import('./features/stacks/stack-services-tab').then((m) => m.StackServicesTab),
      },
    ],
  },

  {
    path: 'compose',
    canActivate: [requiresPermission('compose.read')],
    loadComponent: () => import('./features/compose/compose-list').then((m) => m.ComposeList),
  },
  {
    path: 'compose/:id',
    canActivate: [requiresPermission('compose.read')],
    loadComponent: () => import('./features/compose/compose-detail').then((m) => m.ComposeDetail),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      {
        path: 'overview',
        loadComponent: () =>
          import('./features/compose/compose-overview-tab').then((m) => m.ComposeOverviewTab),
      },
      {
        path: 'services',
        loadComponent: () =>
          import('./features/compose/compose-services-tab').then((m) => m.ComposeServicesTab),
      },
    ],
  },

  {
    path: 'actions',
    canActivate: [requiresPermission('containers.read')],
    loadComponent: () =>
      import('./features/operations/action-history').then((m) => m.ActionHistory),
  },

  {
    path: 'health',
    canActivate: [requiresPermission('hosts.read')],
    loadComponent: () => import('./features/health/health').then((m) => m.Health),
  },

  {
    path: 'agents',
    canActivate: [requiresPermission('agents.read')],
    loadComponent: () => import('./features/agents/agent-list').then((m) => m.AgentList),
  },
  {
    path: 'users',
    canActivate: [requiresPermission('users.read')],
    loadComponent: () => import('./features/administration/user-list').then((m) => m.UserList),
  },
  {
    path: 'roles',
    canActivate: [requiresPermission('roles.read')],
    loadComponent: () => import('./features/administration/role-list').then((m) => m.RoleList),
  },
  {
    path: 'audit',
    canActivate: [requiresPermission('audit.read')],
    loadComponent: () => import('./features/administration/audit-log').then((m) => m.AuditLog),
  },
  {
    path: 'settings',
    canActivate: [requiresSession],
    loadComponent: () => import('./features/settings/settings').then((m) => m.Settings),
  },

  {
    path: '**',
    loadComponent: () => import('./features/not-found/not-found').then((m) => m.NotFound),
  },
];
