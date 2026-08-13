/**
 * What deleting a stack turned out to have done to its host.
 *
 * A pure function, like the classifiers for applying a revision and for moving
 * one between running and stopped, and for the same reason: every case here is
 * a table entry rather than a scenario somebody has to reproduce against a host
 * that lost its connection at the wrong moment.
 *
 * The success condition is narrow and it is about containers only. A stack is
 * removed from its host when no container claims to be part of it any more.
 * Volumes and networks it used are deliberately not part of the question:
 * Dockplane does not remove them, so their being there is the expected outcome
 * rather than an unfinished removal.
 */

export type StackDeleteOutcome =
  /** Nothing on the host claims to be this stack. The configuration may go. */
  | { kind: 'finalize_deleted' }
  /**
   * Every service is still there. The removal never reached the host, or it
   * refused before it changed anything, and the stack is exactly as it was.
   */
  | { kind: 'finalize_not_applied' }
  /**
   * Some containers are gone and some are not.
   *
   * Nothing is rebuilt — recreating one would mean inventing a configuration
   * from a revision that may itself be about to be deleted — and nothing about
   * the stack's saved configuration is removed either, because it is what
   * somebody will need to make sense of the host.
   */
  | { kind: 'needs_attention'; reason: string }
  /** The host could not be read well enough to say. Nothing is concluded. */
  | { kind: 'unknown'; reason: string };

/** One container the host still shows for this stack. */
export interface ObservedClaim {
  readonly serviceName: string;
  readonly containerId: string;
  /** Absent when the resource has no container on the host. */
  readonly dockerId: string | null;
}

export interface StackDeleteInput {
  /** The services the deployed revision described. */
  readonly expectedServices: readonly string[];
  /** What the host shows for this stack, after a complete reading. */
  readonly observed: readonly ObservedClaim[];
  readonly snapshotComplete: boolean;
}

export function classifyStackDelete(input: StackDeleteInput): StackDeleteOutcome {
  if (!input.snapshotComplete) {
    return { kind: 'unknown', reason: 'the host was not read completely' };
  }

  const present = input.observed.filter((claim) => claim.dockerId !== null);

  if (present.length === 0) {
    return { kind: 'finalize_deleted' };
  }

  /*
   * A container claiming a service the deployed revision does not describe.
   *
   * The removal was for the services that were deployed, so something else of
   * this stack is on the host — an older service, or a container somebody
   * restored. Nothing is concluded and nothing more is removed.
   */
  const expected = new Set(input.expectedServices);
  const unexpected = present.find((claim) => !expected.has(claim.serviceName));

  if (unexpected) {
    return {
      kind: 'needs_attention',
      reason: `the host still holds ${unexpected.serviceName}, which the deleted revision does not describe`,
    };
  }

  const claimed = new Set(present.map((claim) => claim.serviceName));

  if (claimed.size === expected.size) {
    return { kind: 'finalize_not_applied' };
  }

  return { kind: 'needs_attention', reason: 'part of the stack was removed and part of it was not' };
}
