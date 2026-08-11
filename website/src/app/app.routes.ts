import { Routes } from '@angular/router';

import { PageMetadata } from './core/page-metadata';

function metadata(value: PageMetadata): { metadata: PageMetadata } {
  return { metadata: value };
}

const NOT_FOUND_METADATA = metadata({
  title: 'Page not found — Dockplane',
  description: 'The requested page could not be found on the Dockplane website.',
  noIndex: true,
});

const loadNotFound = () => import('./pages/not-found/not-found').then((m) => m.NotFound);

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/home/home').then((m) => m.Home),
    data: metadata({
      title: 'Dockplane — Self-Hosted Multi-Host Docker Management',
      description:
        'Dockplane is a self-hosted control plane for managing containers, Compose stacks, logs, health and operations across multiple Docker hosts.',
    }),
  },
  {
    path: 'product',
    loadComponent: () => import('./pages/product/product').then((m) => m.Product),
    data: metadata({
      title: 'Product — Dockplane',
      description:
        'Hosts, containers, Compose projects, logs, events and resource-scoped permissions in one self-hosted Docker control plane.',
    }),
  },
  {
    path: 'features',
    loadComponent: () => import('./pages/features/features').then((m) => m.Features),
    data: metadata({
      title: 'Features — Dockplane',
      description:
        'Host inventory, container lifecycle, Compose projects, Docker resources, operational context, roles and audit history in a self-hosted Docker control plane.',
    }),
  },
  {
    path: 'security',
    loadComponent: () => import('./pages/security/security').then((m) => m.Security),
    data: metadata({
      title: 'Security — Dockplane',
      description:
        'Agent identity, explicit capabilities instead of a remote shell, backend-enforced authorization and auditable operations in Dockplane.',
    }),
  },
  {
    path: 'docs',
    loadComponent: () => import('./pages/docs/docs').then((m) => m.Docs),
    data: metadata({
      title: 'Documentation — Dockplane',
      description:
        'Deployment topology, host enrollment and the documentation set for the self-hosted Dockplane control plane.',
    }),
  },
  {
    path: 'changelog',
    loadComponent: () => import('./pages/changelog/changelog').then((m) => m.Changelog),
    data: metadata({
      title: 'Changelog — Dockplane',
      description: 'User-facing changes to Dockplane, written from an operator perspective.',
    }),
  },
  {
    // Prerendered so static hosting can serve 404.html for unknown addresses.
    path: '404',
    loadComponent: loadNotFound,
    data: NOT_FOUND_METADATA,
  },
  {
    path: '**',
    loadComponent: loadNotFound,
    data: NOT_FOUND_METADATA,
  },
];

/** Paths that are prerendered and eligible for the sitemap. */
export const PRERENDERED_PATHS = [
  '',
  'product',
  'features',
  'security',
  'docs',
  'changelog',
  '404',
] as const;
