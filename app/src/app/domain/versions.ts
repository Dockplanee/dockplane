/**
 * What is running, and whether anything newer exists.
 *
 * Two separate things, kept separate. Everything under `installed` is read from
 * this installation and is available whether or not it can reach anything;
 * everything under the update check depends on a request that is off unless an
 * administrator turned it on and can fail without consequence.
 */

export interface ComponentVersion {
  readonly version: string;
  readonly commit: string;
}

export interface AgentVersionCount {
  /** Null for an agent that has never reported a version. */
  readonly version: string | null;
  readonly count: number;
}

export interface AgentVersionSummary {
  readonly total: number;
  readonly versions: readonly AgentVersionCount[];
  readonly mixedVersions: boolean;
  readonly unknownCount: number;
  /**
   * Agents speaking a protocol the control server does not support.
   *
   * The only agent state that is a fault. An agent on an older release whose
   * protocol is still supported is running as intended.
   */
  readonly protocolUnsupportedCount: number;
  readonly oldestVersion: string | null;
  readonly newestVersion: string | null;
}

export interface InstalledVersions {
  readonly controlServer: ComponentVersion;
  readonly schema: {
    readonly expected: string;
    readonly applied: string | null;
    readonly mismatch: boolean;
  };
  readonly protocol: {
    readonly server: number;
    readonly minimumSupported: number;
  };
  /** Absent for a user who may not see the agents. */
  readonly agents: AgentVersionSummary | null;
}

/**
 * `disabled` is the shipped state: nobody asked, so nobody was asked.
 * `unavailable` is silence from an upstream that was asked, which is not the
 * same as an answer that there is nothing newer.
 */
export type UpdateCheckState = 'disabled' | 'unknown' | 'ok' | 'unavailable' | 'unsupported';

export interface UpdateCheck {
  readonly state: UpdateCheckState;
  readonly latestStableVersion: string | null;
  readonly releaseUrl: string | null;
  readonly checkedAt: string | null;
  readonly updateAvailable: boolean | null;
  /** The answer is older than the interval it is refreshed on. */
  readonly stale: boolean;
}
