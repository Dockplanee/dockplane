import { AppError } from '../common/errors';
import { compareVersions } from '../version/semver';

/**
 * The first agent release whose container listing carries stack attribution.
 *
 * Discovery decides which containers belong to a stack from three labels the
 * agent sets when it creates them: the stack, the service and the revision.
 * Agents before this release set those labels on the host but did not forward
 * them, so the control server recorded their containers with no stack at all.
 *
 * What that costs is not a missing column. A stack whose containers are running
 * reads as never deployed, every operation that resolves containers through the
 * attribution finds none, and a removal that finds none has nothing to remove —
 * which it would otherwise report as having succeeded.
 */
export const STACK_ATTRIBUTION_MINIMUM_AGENT_VERSION = '0.3.0-rc.2';

/**
 * Whether an agent of this version reports which stack its containers belong to.
 *
 * Compared by Semantic Versioning precedence rather than as text, so 0.3.0-rc.2
 * is below 0.3.0 and 0.10.0 is above 0.9.0. Build metadata takes no part, which
 * is what lets the version an agent reports — `0.3.0-rc.2+<commit>` — be read
 * against a plain release number.
 *
 * An unreadable or absent version is not supported. It is the answer for an
 * agent that has never reported a version and for a build nobody recognises,
 * and in both cases the control server cannot show that the attribution it
 * needs will arrive.
 */
export function supportsStackAttribution(version: string | null | undefined): boolean {
  const order = compareVersions(version, STACK_ATTRIBUTION_MINIMUM_AGENT_VERSION);

  return order !== null && order >= 0;
}

/**
 * Refuses a stack operation when the host's agent cannot report attribution.
 *
 * Thrown before anything is dispatched, so a host whose agent is too old is left
 * exactly as it was. The protocol is not the problem and is not named: an older
 * agent goes on serving every other operation, and telling an operator that
 * their protocol is unsupported would send them looking for the wrong thing.
 */
export function assertStackAttribution(
  version: string | null | undefined,
  what: string,
): void {
  if (supportsStackAttribution(version)) {
    return;
  }

  throw AppError.conflict(
    'AGENT_UPGRADE_REQUIRED',
    `The agent on this host is older than ${STACK_ATTRIBUTION_MINIMUM_AGENT_VERSION} and does not report which stack its containers belong to, so ${what}. Upgrade the agent on this host.`,
  );
}
