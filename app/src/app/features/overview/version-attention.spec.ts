import { host } from '../../../testing/data';
import { TestData } from '../../../testing/test-api';
import { renderView } from '../../../testing/harness';
import { AgentVersionSummary, InstalledVersions, UpdateCheck } from '../../domain/versions';
import { Overview } from './overview';

/**
 * Version state on the dashboard, and only when there is state.
 *
 * The overview earns its space by showing what needs looking at. A permanent
 * card carrying a version number would take room from the things that do, so
 * these entries appear when something is worth saying and are absent otherwise.
 */

const PERMISSIONS = ['hosts.read', 'containers.read', 'compose.read'] as const;

const fleet = (overrides: Partial<AgentVersionSummary> = {}): AgentVersionSummary => ({
  total: 2,
  versions: [],
  mixedVersions: false,
  unknownCount: 0,
  protocolUnsupportedCount: 0,
  oldestVersion: null,
  newestVersion: null,
  ...overrides,
});

const installed = (overrides: Partial<InstalledVersions> = {}): InstalledVersions => ({
  controlServer: { version: '0.3.0', commit: 'abcdef123456' },
  schema: { expected: '0007_schema', applied: '0007_schema', mismatch: false },
  protocol: { server: 1, minimumSupported: 1 },
  agents: fleet(),
  ...overrides,
});

const check = (overrides: Partial<UpdateCheck> = {}): UpdateCheck => ({
  state: 'disabled',
  latestStableVersion: null,
  releaseUrl: null,
  checkedAt: null,
  updateAvailable: null,
  stale: false,
  ...overrides,
});

async function render(data: TestData = {}) {
  const fixture = await renderView(Overview, {
    permissions: [...PERMISSIONS],
    data: { hosts: [host()], installedVersions: installed(), updateCheck: check(), ...data },
  });

  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();

  const attention = (fixture.nativeElement as HTMLElement).querySelector('.issues');

  return attention?.textContent ?? '';
}

describe('version state on the overview', () => {
  it('says nothing about versions when there is nothing to say', async () => {
    const text = await render();

    expect(text).not.toContain('version');
    expect(text).not.toContain('published');
  });

  it('reports a fleet on several versions as information', async () => {
    const text = await render({
      installedVersions: installed({
        agents: fleet({ mixedVersions: true, oldestVersion: '0.2.0', newestVersion: '0.3.0' }),
      }),
    });

    expect(text).toContain('different versions');
    expect(text).toContain('0.2.0 through 0.3.0');
  });

  it('reports an agent the server cannot drive', async () => {
    const text = await render({
      installedVersions: installed({ agents: fleet({ protocolUnsupportedCount: 1 }) }),
    });

    expect(text).toContain('unsupported protocol');
  });

  it('reports a database that is behind the build', async () => {
    const text = await render({
      installedVersions: installed({
        schema: { expected: '0008_next', applied: '0007_schema', mismatch: true },
      }),
    });

    expect(text).toContain('schema is behind');
  });

  it('reports a published release and says installing is manual', async () => {
    const text = await render({
      updateCheck: check({
        state: 'ok',
        latestStableVersion: '0.4.0',
        checkedAt: '2026-08-16T10:00:00.000Z',
        updateAvailable: true,
      }),
    });

    expect(text).toContain('0.4.0 has been published');
    expect(text).toContain('nothing here starts it');
  });

  // The shipped configuration asks nobody, so there is nothing to announce.
  it('claims no published release while the check is off', async () => {
    const text = await render({ updateCheck: check({ state: 'disabled' }) });

    expect(text).not.toContain('published');
  });

  it('says nothing when the update check could not reach anyone', async () => {
    const text = await render({ updateCheck: check({ state: 'unavailable' }) });

    expect(text).not.toContain('published');
  });
});
