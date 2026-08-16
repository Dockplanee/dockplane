import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { routes } from '../../app.routes';
import { DockplaneApi } from '../../data/dockplane-api';
import { AgentVersionSummary, InstalledVersions, UpdateCheck } from '../../domain/versions';
import { signIn } from '../../../testing/harness';
import { TestApi, TestData } from '../../../testing/test-api';
import { SystemVersion } from './system-version';

/**
 * What an operator can find out about their own installation.
 *
 * The panel is read-only by design: everything here is a sentence, and the
 * absence of any control that installs, upgrades or downloads is part of what
 * these tests hold in place.
 */

const fleet = (overrides: Partial<AgentVersionSummary> = {}): AgentVersionSummary => ({
  total: 0,
  versions: [],
  mixedVersions: false,
  unknownCount: 0,
  protocolUnsupportedCount: 0,
  oldestVersion: null,
  newestVersion: null,
  ...overrides,
});

const installed = (overrides: Partial<InstalledVersions> = {}): InstalledVersions => ({
  controlServer: { version: '0.3.0', commit: 'abcdef123456789' },
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

describe('the system version panel', () => {
  let api: TestApi;

  const render = async (data: TestData = {}) => {
    api = new TestApi({ installedVersions: installed(), updateCheck: check(), ...data });

    await TestBed.configureTestingModule({
      imports: [SystemVersion],
      providers: [provideRouter(routes), { provide: DockplaneApi, useValue: api }],
    }).compileComponents();

    signIn(['agents.read']);

    const fixture = TestBed.createComponent(SystemVersion);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    return fixture;
  };

  const text = (fixture: Awaited<ReturnType<typeof render>>) =>
    (fixture.nativeElement as HTMLElement).textContent ?? '';

  const line = (fixture: Awaited<ReturnType<typeof render>>, label: string) => {
    const rows = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.line')];

    return rows.find((row) => row.querySelector('dt')?.textContent?.trim() === label) ?? null;
  };

  it('names the control server and the browser application separately', async () => {
    const fixture = await render();

    expect(line(fixture, 'Dockplane Server')?.textContent).toContain('0.3.0');
    expect(line(fixture, 'Web Interface')).not.toBeNull();
  });

  /*
   * The bundle under test is built without the release constants, so it
   * reports the development version rather than borrowing the server's. That
   * is the behaviour: the browser says what it is, not what the server is.
   */
  it('reports the browser application from the bundle rather than from the server', async () => {
    const fixture = await render();

    expect(line(fixture, 'Web Interface')?.textContent).toContain('0.0.0-dev');
    expect(line(fixture, 'Web Interface')?.textContent).toContain('Differs from the server');
  });

  it('shows the schema the database has reached', async () => {
    const fixture = await render();

    expect(line(fixture, 'Database Schema')?.textContent).toContain('0007_schema');
    expect(text(fixture)).not.toContain('Migration pending');
  });

  it('calls out a database that is behind the build', async () => {
    const fixture = await render({
      installedVersions: installed({
        schema: { expected: '0008_next', applied: '0007_schema', mismatch: true },
      }),
    });

    expect(line(fixture, 'Database Schema')?.textContent).toContain('Migration pending');
    expect(line(fixture, 'Database Schema')?.textContent).toContain('0008_next');
  });

  it('shows the protocol the server speaks', async () => {
    const fixture = await render();

    expect(line(fixture, 'Agent Protocol')?.textContent).toContain('v1');
  });

  describe('the agents', () => {
    it('says how many there are and what they run', async () => {
      const fixture = await render({
        installedVersions: installed({
          agents: fleet({
            total: 3,
            versions: [{ version: '0.3.0', count: 3 }],
            newestVersion: '0.3.0',
            oldestVersion: '0.3.0',
          }),
        }),
      });

      expect(line(fixture, 'Agents')?.textContent).toContain('3 agents');
      expect(line(fixture, 'Agents')?.textContent).toContain('0.3.0');
      expect(text(fixture)).not.toContain('Mixed versions');
    });

    // Worth knowing, and not an error: these agents are working.
    it('marks a fleet on more than one version without calling it a fault', async () => {
      const fixture = await render({
        installedVersions: installed({
          agents: fleet({
            total: 3,
            versions: [
              { version: '0.3.0', count: 2 },
              { version: '0.2.0', count: 1 },
            ],
            mixedVersions: true,
            oldestVersion: '0.2.0',
            newestVersion: '0.3.0',
          }),
        }),
      });

      const badge = line(fixture, 'Agents')?.querySelector('dp-status-badge');

      expect(badge?.textContent).toContain('Mixed versions');
      expect(badge?.className).toContain('tone-warn');
      expect(badge?.className).not.toContain('tone-critical');
    });

    it('reports agents that have not named a version', async () => {
      const fixture = await render({
        installedVersions: installed({
          agents: fleet({
            total: 2,
            versions: [
              { version: '0.3.0', count: 1 },
              { version: null, count: 1 },
            ],
            unknownCount: 1,
            oldestVersion: '0.3.0',
            newestVersion: '0.3.0',
          }),
        }),
      });

      expect(line(fixture, 'Agents')?.textContent).toContain('1 not reporting a version');
    });

    // The one agent state that is an incompatibility rather than an
    // observation, and the only one shown as critical.
    it('calls an unsupported protocol what it is', async () => {
      const fixture = await render({
        installedVersions: installed({
          agents: fleet({ total: 1, protocolUnsupportedCount: 1 }),
        }),
      });

      const badge = line(fixture, 'Agents')?.querySelector('dp-status-badge');

      expect(badge?.textContent).toContain('Protocol not supported');
      expect(badge?.className).toContain('tone-critical');
    });

    it('is absent for a user who may not see the agents', async () => {
      const fixture = await render({ installedVersions: installed({ agents: null }) });

      expect(line(fixture, 'Agents')).toBeNull();
      expect(line(fixture, 'Dockplane Server')).not.toBeNull();
    });
  });

  describe('the update check', () => {
    it('says it is off, and claims nothing about a published version', async () => {
      const fixture = await render();

      expect(line(fixture, 'Updates')?.textContent).toContain('off');
      expect(text(fixture)).not.toContain('Update available');
    });

    it('reports a newer published release without offering to install it', async () => {
      const fixture = await render({
        updateCheck: check({
          state: 'ok',
          latestStableVersion: '0.4.0',
          releaseUrl: 'https://example.test/0.4.0',
          checkedAt: '2026-08-16T10:00:00.000Z',
          updateAvailable: true,
        }),
      });

      expect(line(fixture, 'Updates')?.textContent).toContain('0.4.0');
      expect(line(fixture, 'Updates')?.querySelector('dp-status-badge')?.textContent).toContain(
        'Update available',
      );

      // Nothing in the panel acts.
      expect(
        (fixture.nativeElement as HTMLElement).querySelectorAll('button, input, a[href]'),
      ).toHaveLength(0);
    });

    it('says so when nothing newer has been published', async () => {
      const fixture = await render({
        updateCheck: check({
          state: 'ok',
          latestStableVersion: '0.3.0',
          checkedAt: '2026-08-16T10:00:00.000Z',
          updateAvailable: false,
        }),
      });

      expect(line(fixture, 'Updates')?.textContent).toContain('newest published release');
      expect(text(fixture)).not.toContain('Update available');
    });

    it('distinguishes an upstream that could not be reached from an answer', async () => {
      const fixture = await render({ updateCheck: check({ state: 'unavailable' }) });

      expect(line(fixture, 'Updates')?.textContent).toContain('could not be reached');
      expect(text(fixture)).not.toContain('Update available');
    });

    it('marks an answer it has been carrying for a while', async () => {
      const fixture = await render({
        updateCheck: check({
          state: 'ok',
          latestStableVersion: '0.3.0',
          checkedAt: '2026-08-15T10:00:00.000Z',
          updateAvailable: false,
          stale: true,
        }),
      });

      expect(line(fixture, 'Updates')?.textContent).toContain('Last successful check');
    });

    it('reports an upstream release it cannot read a version from', async () => {
      const fixture = await render({ updateCheck: check({ state: 'unsupported' }) });

      expect(line(fixture, 'Updates')?.textContent).toContain('no version');
    });

    // The local versions are the point of the panel, and a check that fails
    // must not take them with it.
    it('still reports the installation when the check request fails', async () => {
      const fixture = await render({ updateCheckError: new Error('offline') });

      expect(line(fixture, 'Dockplane Server')?.textContent).toContain('0.3.0');
      expect(line(fixture, 'Updates')).toBeNull();
    });
  });

  it('says so when the control server does not answer at all', async () => {
    const fixture = await render({ installedVersionsError: new Error('unreachable') });

    expect(text(fixture)).toContain('did not report its versions');
  });
});
