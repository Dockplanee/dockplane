import { ExternalDestination, externalLink } from './site.config';

export interface NavLink {
  readonly label: string;
  /** Internal router path. */
  readonly path: string;
}

export interface FooterLink {
  readonly label: string;
  readonly path?: string;
  readonly href?: string;
}

export interface FooterGroup {
  readonly title: string;
  readonly links: readonly FooterLink[];
}

interface FooterLinkSource {
  readonly label: string;
  readonly path?: string;
  readonly external?: ExternalDestination;
}

export const PRIMARY_NAV: readonly NavLink[] = [
  { label: 'Product', path: '/product' },
  { label: 'Features', path: '/features' },
  { label: 'Security', path: '/security' },
  { label: 'Docs', path: '/docs' },
  { label: 'Changelog', path: '/changelog' },
];

export const GET_STARTED: NavLink = { label: 'Get Started', path: '/docs' };

const FOOTER_SOURCE: readonly { title: string; links: readonly FooterLinkSource[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'Overview', path: '/product' },
      { label: 'Features', path: '/features' },
      { label: 'Security', path: '/security' },
      { label: 'Changelog', path: '/changelog' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Documentation', path: '/docs' },
      { label: 'Releases', external: 'releases' },
    ],
  },
  {
    title: 'Project',
    links: [
      { label: 'Security policy', path: '/security' },
      { label: 'Source', external: 'source' },
      { label: 'Issues', external: 'issues' },
      { label: 'License', external: 'license' },
    ],
  },
];

/**
 * Footer navigation with unresolved external destinations removed, so the
 * public site never renders a link to something that does not exist yet.
 */
export function buildFooterGroups(): FooterGroup[] {
  return FOOTER_SOURCE.map((group) => ({
    title: group.title,
    links: group.links.flatMap<FooterLink>((link) => {
      if (!link.external) {
        return link.path ? [{ label: link.label, path: link.path }] : [];
      }

      const href = externalLink(link.external);
      return href ? [{ label: link.label, href }] : [];
    }),
  })).filter((group) => group.links.length > 0);
}
