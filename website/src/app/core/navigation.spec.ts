import { EXTERNAL_LINKS, ExternalDestination } from './site.config';
import { PRIMARY_NAV, buildFooterGroups } from './navigation';

describe('navigation', () => {
  const originalLinks = { ...EXTERNAL_LINKS };

  afterEach(() => {
    for (const key of Object.keys(EXTERNAL_LINKS) as ExternalDestination[]) {
      EXTERNAL_LINKS[key] = originalLinks[key];
    }
  });

  it('links every primary navigation entry to an internal route', () => {
    for (const link of PRIMARY_NAV) {
      expect(link.path.startsWith('/')).toBe(true);
      expect(link.label.length).toBeGreaterThan(0);
    }
  });

  it('gives every rendered entry a destination', () => {
    const links = buildFooterGroups().flatMap((group) => group.links);

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.path ?? link.href).toBeTruthy();
    }
  });

  it('omits an external destination while it is unset', () => {
    EXTERNAL_LINKS.source = null;

    const labels = buildFooterGroups()
      .flatMap((group) => group.links)
      .map((link) => link.label);

    expect(labels).not.toContain('Source');
  });

  it('includes an external destination once it is configured', () => {
    EXTERNAL_LINKS.source = 'https://example.test/dockplane';

    const links = buildFooterGroups().flatMap((group) => group.links);
    const source = links.find((link) => link.label === 'Source');

    expect(source?.href).toBe('https://example.test/dockplane');
  });

  it('keeps the internal entries of a group when its external ones are unset', () => {
    for (const key of Object.keys(EXTERNAL_LINKS) as ExternalDestination[]) {
      EXTERNAL_LINKS[key] = null;
    }

    const links = buildFooterGroups().flatMap((group) => group.links);

    expect(links.every((link) => link.path)).toBe(true);
    expect(links.map((link) => link.label)).toContain('Security policy');
  });

  it('never renders an empty group', () => {
    for (const group of buildFooterGroups()) {
      expect(group.links.length).toBeGreaterThan(0);
    }
  });
});
