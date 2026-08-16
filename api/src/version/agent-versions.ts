import { MINIMUM_PROTOCOL_VERSION, PROTOCOL_VERSION } from '../agents/protocol';
import { ParsedVersion, compareParsed, parseVersion } from './semver';

/**
 * What the fleet is running, said once rather than per host.
 *
 * A browser cannot answer "are the agents in step" by fetching five hundred
 * hosts and working it out, and it should not have to: the question is about
 * the installation, so the installation answers it. Nothing host-specific
 * belongs in the answer — a host that needs naming is a row in the agents list,
 * not a field here.
 */

export interface AgentVersionCount {
  /** Null for an agent that has never reported one. */
  readonly version: string | null;
  readonly count: number;
}

export interface AgentVersionSummary {
  /** Agents that count towards the picture: enrolled and not revoked. */
  readonly total: number;
  readonly versions: readonly AgentVersionCount[];
  /** More than one readable version is in use. */
  readonly mixedVersions: boolean;
  /** Agents that reported no version, or one that cannot be read. */
  readonly unknownCount: number;
  /**
   * Agents speaking a protocol this build does not support.
   *
   * This is the only agent state that is an incompatibility rather than an
   * observation. An older agent is supported as long as its protocol is inside
   * the range this server accepts, which is what the release contract promises;
   * calling it out of date because its version string is lower would be a
   * warning about something that works.
   */
  readonly protocolUnsupportedCount: number;
  /** The lowest and highest readable versions in use, when there are any. */
  readonly oldestVersion: string | null;
  readonly newestVersion: string | null;
}

export interface AgentVersionRow {
  readonly version: string | null;
  readonly protocolVersion: number;
}

function normalise(version: string | null): string | null {
  return typeof version === 'string' && version.trim() ? version.trim() : null;
}

export function summariseAgentVersions(rows: readonly AgentVersionRow[]): AgentVersionSummary {
  const counts = new Map<string | null, number>();
  const readable = new Map<string, ParsedVersion>();
  let unknownCount = 0;
  let protocolUnsupportedCount = 0;

  for (const row of rows) {
    const version = normalise(row.version);
    const parsed = version === null ? null : parseVersion(version);

    counts.set(version, (counts.get(version) ?? 0) + 1);

    if (parsed) {
      readable.set(version as string, parsed);
    } else {
      // A version nobody can read is in use and says nothing about where it
      // sits, which is the same position as one that was never reported.
      unknownCount += 1;
    }

    if (row.protocolVersion < MINIMUM_PROTOCOL_VERSION || row.protocolVersion > PROTOCOL_VERSION) {
      protocolUnsupportedCount += 1;
    }
  }

  const ordered = [...readable.entries()].sort(([, a], [, b]) => compareParsed(a, b));

  const versions = [...counts.entries()]
    .map(([version, count]) => ({ version, count }))
    .sort((a, b) => {
      // Most-used first, so a fleet with one straggler reads as one.
      if (a.count !== b.count) return b.count - a.count;
      if (a.version === null) return 1;
      if (b.version === null) return -1;

      const left = readable.get(a.version);
      const right = readable.get(b.version);

      return left && right ? compareParsed(right, left) : a.version.localeCompare(b.version);
    });

  return {
    total: rows.length,
    versions,
    mixedVersions: readable.size > 1,
    unknownCount,
    protocolUnsupportedCount,
    oldestVersion: ordered[0]?.[0] ?? null,
    newestVersion: ordered[ordered.length - 1]?.[0] ?? null,
  };
}
