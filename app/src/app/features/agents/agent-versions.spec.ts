import { renderView } from '../../../testing/harness';
import { AgentVersionSummary, InstalledVersions } from '../../domain/versions';
import { Agent } from '../../domain/operations';
import { AgentList } from './agent-list';

/**
 * Which agent is behind, said where an operator is already looking.
 *
 * The list marks a row against the newest version the control server reports —
 * it does not work out an ordering of its own, and it says nothing at all while
 * the fleet is in step.
 */

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: '11111111-2222-3333-4444-555555555555',
  hostId: 'host-1',
  hostname: 'docker-01',
  hostName: 'docker-01',
  certificateNotAfter: '2027-01-01T00:00:00.000Z',
  version: '0.3.0',
  protocolVersion: 1,
  status: 'connected',
  enrolledAt: '2026-08-01T00:00:00.000Z',
  lastSeen: '2026-08-16T10:00:00.000Z',
  connected: true,
  ...overrides,
});

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

const installed = (agents: AgentVersionSummary | null): InstalledVersions => ({
  controlServer: { version: '0.3.0', commit: 'abcdef123456' },
  schema: { expected: '0007_schema', applied: '0007_schema', mismatch: false },
  protocol: { server: 1, minimumSupported: 1 },
  agents,
});

async function render(agents: readonly Agent[], summary: AgentVersionSummary | null) {
  const fixture = await renderView(AgentList, {
    permissions: ['agents.read'],
    data: { agents: [...agents], installedVersions: installed(summary) },
  });

  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();

  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

describe('agent versions in the list', () => {
  it('says nothing when every agent is on the same version', async () => {
    const text = await render(
      [agent(), agent({ id: 'second', version: '0.3.0' })],
      fleet({ versions: [{ version: '0.3.0', count: 2 }], newestVersion: '0.3.0' }),
    );

    expect(text).not.toContain('Older than');
  });

  it('marks the agent that is behind the newest in use', async () => {
    const text = await render(
      [agent(), agent({ id: 'second', version: '0.2.0' })],
      fleet({
        versions: [
          { version: '0.3.0', count: 1 },
          { version: '0.2.0', count: 1 },
        ],
        mixedVersions: true,
        oldestVersion: '0.2.0',
        newestVersion: '0.3.0',
      }),
    );

    expect(text).toContain('Older than 0.3.0');
  });

  // Nothing is known about where it sits, so nothing is claimed.
  it('does not mark an agent that has reported no version', async () => {
    const text = await render(
      [agent(), agent({ id: 'second', version: undefined })],
      fleet({
        versions: [
          { version: '0.3.0', count: 1 },
          { version: null, count: 1 },
        ],
        unknownCount: 1,
        newestVersion: '0.3.0',
      }),
    );

    expect(text).not.toContain('Older than');
  });

  // The list is still a list when the summary cannot be read.
  it('renders without the summary', async () => {
    const text = await render([agent()], null);

    expect(text).toContain('docker-01');
    expect(text).not.toContain('Older than');
  });
});
