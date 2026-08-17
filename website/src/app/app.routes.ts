import { Routes } from '@angular/router';

import { PageMetadata, StructuredData } from './core/page-metadata';
import { SITE_DESCRIPTION, SITE_NAME, absoluteUrl, externalLink } from './core/site.config';

function metadata(value: PageMetadata): { metadata: PageMetadata } {
  return { metadata: value };
}

/**
 * What the site is.
 *
 * The two facts a search engine cannot read off the page reliably: that these
 * addresses are one site, and what it is called.
 */
const WEBSITE: StructuredData = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: SITE_NAME,
  url: absoluteUrl('/'),
  description: SITE_DESCRIPTION,
};

/**
 * What the software is.
 *
 * Deliberately without a version, a release date, a price, a rating or a
 * download address. Dockplane's releases are published from the repository and
 * a version here would be a second place claiming which one is current — one
 * that goes stale the moment it is written.
 */
const SOFTWARE: StructuredData = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: SITE_NAME,
  url: absoluteUrl('/product'),
  description:
    'A self-hosted control plane for managing Docker across multiple hosts, with a native agent on each host.',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Linux',
  license: 'https://www.gnu.org/licenses/agpl-3.0.html',
  ...(externalLink('source') ? { codeRepository: externalLink('source') } : {}),
};

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
      structuredData: WEBSITE,
    }),
  },
  {
    path: 'product',
    loadComponent: () => import('./pages/product/product').then((m) => m.Product),
    data: metadata({
      title: 'Docker hosts, containers and stacks — Dockplane',
      description:
        'Hosts, containers, managed Compose stacks, logs, events and backend-enforced permissions in one self-hosted Docker control plane.',
      structuredData: SOFTWARE,
    }),
  },
  {
    path: 'features',
    loadComponent: () => import('./pages/features/features').then((m) => m.Features),
    data: metadata({
      title: 'Features — Dockplane',
      description:
        'Host inventory, container lifecycle, managed Compose stacks, version visibility, operational context, roles and audit history in a self-hosted Docker control plane.',
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
