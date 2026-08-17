/**
 * Central configuration for the public website.
 *
 * External destinations are declared in one place so that pages never hardcode
 * a URL. A `null` value means the destination does not exist yet: navigation,
 * footer entries and calls to action that point at it are omitted instead of
 * rendering a dead link.
 */

export type ExternalDestination =
  | 'source'
  | 'releases'
  | 'issues'
  | 'discussions'
  | 'license'
  | 'securityAdvisory'
  | 'securityModel';

/** Absolute origin the public site is deployed to. Used for canonical URLs, sitemap entries and social metadata. */
export const SITE_ORIGIN = 'https://dockplane.de';

export const SITE_NAME = 'Dockplane';

export const SITE_TAGLINE = 'Your Docker hosts. One control plane.';

export const SITE_DESCRIPTION =
  'Dockplane is a self-hosted control plane for managing containers, Compose stacks, logs, health and operations across multiple Docker hosts.';

const SOURCE_REPOSITORY = 'https://github.com/Dockplanee/dockplane';

export const EXTERNAL_LINKS: Record<ExternalDestination, string | null> = {
  source: SOURCE_REPOSITORY,
  issues: `${SOURCE_REPOSITORY}/issues`,
  releases: `${SOURCE_REPOSITORY}/releases`,
  // Private vulnerability reporting; requires the repository setting to be enabled.
  securityAdvisory: `${SOURCE_REPOSITORY}/security/advisories/new`,
  // The capability catalogue is maintained here and deliberately not copied
  // onto the website, where it would be a second version of the same list.
  securityModel: `${SOURCE_REPOSITORY}/blob/main/docs/security/security-model.md`,
  discussions: null,
  license: null,
};

export function externalLink(destination: ExternalDestination): string | null {
  return EXTERNAL_LINKS[destination];
}

export function hasExternalLink(destination: ExternalDestination): boolean {
  return externalLink(destination) !== null;
}

export function absoluteUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return normalized === '/' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${normalized}`;
}
