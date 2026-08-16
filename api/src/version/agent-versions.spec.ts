import { summariseAgentVersions } from './agent-versions';

const agent = (version: string | null, protocolVersion = 1) => ({ version, protocolVersion });

describe('agent version summary', () => {
  it('says nothing about an installation with no agents', () => {
    expect(summariseAgentVersions([])).toEqual({
      total: 0,
      versions: [],
      mixedVersions: false,
      unknownCount: 0,
      protocolUnsupportedCount: 0,
      oldestVersion: null,
      newestVersion: null,
    });
  });

  it('counts one version once', () => {
    const summary = summariseAgentVersions([agent('0.3.0'), agent('0.3.0'), agent('0.3.0')]);

    expect(summary.total).toBe(3);
    expect(summary.versions).toEqual([{ version: '0.3.0', count: 3 }]);
    expect(summary.mixedVersions).toBe(false);
  });

  it('reports a fleet that is not in step', () => {
    const summary = summariseAgentVersions([agent('0.3.0'), agent('0.3.0'), agent('0.2.0')]);

    expect(summary.mixedVersions).toBe(true);
    expect(summary.versions).toEqual([
      { version: '0.3.0', count: 2 },
      { version: '0.2.0', count: 1 },
    ]);
    expect(summary.oldestVersion).toBe('0.2.0');
    expect(summary.newestVersion).toBe('0.3.0');
  });

  it('orders by version and not by string when the counts match', () => {
    const summary = summariseAgentVersions([agent('0.9.0'), agent('0.10.0')]);

    expect(summary.versions.map((entry) => entry.version)).toEqual(['0.10.0', '0.9.0']);
    expect(summary.newestVersion).toBe('0.10.0');
  });

  it('ranks a release above its own candidate', () => {
    const summary = summariseAgentVersions([agent('0.3.0-rc.4'), agent('0.3.0')]);

    expect(summary.oldestVersion).toBe('0.3.0-rc.4');
    expect(summary.newestVersion).toBe('0.3.0');
  });

  it('counts an agent that has never reported a version as unknown', () => {
    const summary = summariseAgentVersions([agent('0.3.0'), agent(null)]);

    expect(summary.unknownCount).toBe(1);
    expect(summary.mixedVersions).toBe(false);
    expect(summary.versions).toContainEqual({ version: null, count: 1 });
  });

  // A version nobody can read must not decide an ordering, and must not be
  // quietly dropped either: it is in use.
  it('counts an unreadable version as unknown and keeps it visible', () => {
    const summary = summariseAgentVersions([agent('0.3.0'), agent('nightly-2026-08-16')]);

    expect(summary.unknownCount).toBe(1);
    expect(summary.mixedVersions).toBe(false);
    expect(summary.versions).toContainEqual({ version: 'nightly-2026-08-16', count: 1 });
    expect(summary.oldestVersion).toBe('0.3.0');
    expect(summary.newestVersion).toBe('0.3.0');
  });

  it('treats an empty version as no version', () => {
    const summary = summariseAgentVersions([agent('   ')]);

    expect(summary.unknownCount).toBe(1);
    expect(summary.versions).toEqual([{ version: null, count: 1 }]);
  });

  // An older agent whose protocol this build still speaks is supported, and
  // saying otherwise would warn about something that works.
  it('does not call a supported protocol an incompatibility', () => {
    const summary = summariseAgentVersions([agent('0.1.0', 1), agent('0.3.0', 1)]);

    expect(summary.protocolUnsupportedCount).toBe(0);
    expect(summary.mixedVersions).toBe(true);
  });

  it('counts a protocol outside the supported range', () => {
    const summary = summariseAgentVersions([agent('0.3.0', 1), agent('9.9.9', 99), agent(null, 0)]);

    expect(summary.protocolUnsupportedCount).toBe(2);
  });
});
