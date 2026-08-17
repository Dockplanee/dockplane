import { FEATURE_AREAS, OUT_OF_SCOPE, PLANNED } from './feature-catalog';

/**
 * The features page is a claim about what Dockplane can do, made to people who
 * have not installed it. It once listed images, networks, volumes, container
 * metrics, host groups and resource scopes as available; none of them exist —
 * there is no route and no agent capability behind any of them.
 *
 * These are the cheap checks that keep the page honest. The expensive one is
 * reading the capability registry before adding an entry.
 */
describe('the feature catalogue', () => {
  const available = FEATURE_AREAS.flatMap((area) => area.entries.map((entry) => entry.name));

  it('claims nothing this release does not implement', () => {
    // Each of these was on the page as an available capability and was not
    // built. They belong under "planned" until something answers for them.
    for (const claim of [
      'Images',
      'Networks',
      'Volumes',
      'Container metrics',
      'Host groups',
      'Resource scopes',
    ]) {
      expect(available, `"${claim}" is presented as available`).not.toContain(claim);
    }
  });

  it('presents what this release does implement', () => {
    // The other half of the same problem: the page described 0.1 for two
    // releases after 0.1, so containers read as start-stop-restart and every
    // Compose project read as something Dockplane could only look at.
    for (const claim of [
      'Create a container',
      'Change a container',
      'Remove a container',
      'Configuration rollback',
      'Deploy',
      'Archiving',
      'Agent versions',
      'Optional update check',
    ]) {
      expect(available, `"${claim}" is missing from the page`).toContain(claim);
    }
  });

  it('keeps managed stacks and discovered projects apart', () => {
    const ids = FEATURE_AREAS.map((area) => area.id);

    expect(ids).toContain('stacks');
    expect(ids).toContain('compose');

    const discovered = FEATURE_AREAS.find((area) => area.id === 'compose');
    const details = discovered?.entries.map((entry) => entry.detail).join(' ') ?? '';

    // A discovered project is read. Anything else on this page would be the
    // one distinction the product most needs its website to hold.
    expect(details).toMatch(/read-only|not deployed/i);
  });

  it('does not present the same thing as both available and planned', () => {
    const planned = PLANNED.map((entry) => entry.name);

    for (const name of available) {
      expect(planned, `"${name}" is in both lists`).not.toContain(name);
    }
  });

  it('keeps out of scope what the product says is out of scope', () => {
    for (const excluded of ['Proxmox management', 'Kubernetes management']) {
      expect(OUT_OF_SCOPE).toContain(excluded);
      expect(available).not.toContain(excluded);
    }
  });

  it('numbers its areas in order, without a gap', () => {
    expect(FEATURE_AREAS.map((area) => area.index)).toEqual(
      FEATURE_AREAS.map((_, position) => String(position + 1).padStart(2, '0')),
    );
  });

  it('gives every entry a name and an explanation', () => {
    for (const area of FEATURE_AREAS) {
      expect(area.entries.length).toBeGreaterThan(0);

      for (const entry of area.entries) {
        expect(entry.name.length).toBeGreaterThan(0);
        expect(entry.detail.length).toBeGreaterThan(0);
      }
    }
  });
});
