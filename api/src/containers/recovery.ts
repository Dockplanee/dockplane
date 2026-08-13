/**
 * What to do about a mutation nobody is running any more.
 *
 * Creating, replacing and removing a container are Docker side effects, and no
 * database transaction covers one. So the intended configuration is written
 * first and promoted afterwards, and a control server that dies in between
 * leaves a pending row with no process behind it.
 *
 * This decides what that pending row means. It is a pure function: it reads no
 * database, talks to no host, and changes nothing. Everything it needs is in
 * its argument, which makes every case in the table below a test rather than a
 * scenario somebody has to reproduce.
 *
 * Two rules run through all of it.
 *
 * It never decides from observed configuration. A replacement may change
 * nothing but a secret, and observed state holds no environment values by
 * design — so the container says which configuration it is, by carrying its
 * identifier as a label, and that is what is read.
 *
 * It never destroys anything. The outcomes are: promote what was observed,
 * discard what was not, finalise a removal that happened, or stop and say a
 * person is needed. Nothing here removes a container, and nothing here dispatches
 * an operation again — recovery reconciles, it does not retry.
 */

export type RecoveryOperation = 'create' | 'replace' | 'remove';

export type RecoveryDecision =
  /** The candidate is what is running. Make it current. */
  | { kind: 'promote_pending'; desiredConfigId: string }
  /** The candidate never took. Throw it away; what was current still is. */
  | { kind: 'discard_pending'; desiredConfigId: string }
  /** The container is gone and was meant to be. Finish the removal. */
  | { kind: 'finalize_remove' }
  /** More than one container claims this resource. Nobody may guess. */
  | { kind: 'conflict'; reason: string }
  /** Something is wrong in a way that is not a conflict and not resolvable. */
  | { kind: 'needs_attention'; reason: string }
  /** Nothing to do, or nothing that can safely be concluded yet. */
  | { kind: 'no_action'; reason: string };

/** What a container on the host says it is. */
export interface ObservedClaim {
  readonly dockerId: string;
  /** The configuration it carries, or null when it carries none. */
  readonly desiredConfigId: string | null;
}

export interface RecoveryInput {
  readonly operation: RecoveryOperation;
  /** What the resource is. Absent while a create has not completed. */
  readonly currentDesiredConfigId: string | null;
  /** What it is being asked to become. Absent for a removal. */
  readonly pendingDesiredConfigId: string | null;
  /** Containers claiming this Dockplane resource, from the last discovery. */
  readonly claims: readonly ObservedClaim[];
  /**
   * Whether the discovery this was read from finished.
   *
   * Absence of a container only means something if the pass that failed to see
   * it saw everything else. A timed-out agent and an empty host look identical
   * from here, and one of them is not a reason to conclude anything.
   */
  readonly snapshotComplete: boolean;
  /**
   * Whether a live mutation still owns this.
   *
   * A pending configuration with a running operation behind it is not
   * orphaned — it is the normal state of a replacement that has not finished.
   * Deciding anything about it would destroy an operation in progress.
   */
  readonly recoveryEligible: boolean;
}

export function classifyRecovery(input: RecoveryInput): RecoveryDecision {
  const { operation, currentDesiredConfigId, pendingDesiredConfigId, claims } = input;

  if (!input.recoveryEligible) {
    return { kind: 'no_action', reason: 'a mutation is still running against this container' };
  }

  if (!input.snapshotComplete) {
    return { kind: 'no_action', reason: 'the last discovery did not complete' };
  }

  /*
   * More than one container claiming one resource outranks everything.
   *
   * It is what a crash midway through a replacement leaves behind, and it is
   * tempting to resolve: the pending one looks like the winner, the current one
   * looks like the leftover. But the Docker side of the operation did not
   * finish, so which is which is not established — and being wrong here removes
   * somebody's running workload.
   */
  if (claims.length > 1) {
    return {
      kind: 'conflict',
      reason: `${claims.length} containers claim this resource`,
    };
  }

  const claim = claims[0] ?? null;

  if (claim && claim.desiredConfigId === null) {
    /*
     * A managed container that does not say what it is.
     *
     * It may have been edited by hand, or built by a Dockplane that predates
     * this label. Either way its configuration cannot be established, and
     * assuming it is the current one would be assuming the thing in question.
     */
    return {
      kind: 'needs_attention',
      reason: 'the container carries no configuration identity',
    };
  }

  if (
    claim &&
    claim.desiredConfigId !== currentDesiredConfigId &&
    claim.desiredConfigId !== pendingDesiredConfigId
  ) {
    return {
      kind: 'needs_attention',
      reason: 'the container claims a configuration this resource does not have',
    };
  }

  if (operation === 'remove') {
    if (!claim) {
      return { kind: 'finalize_remove' };
    }

    // Still there, so the removal did not happen. Saying so is the whole
    // answer; asking for it again is not recovery's decision to make.
    return { kind: 'needs_attention', reason: 'the container is still present' };
  }

  if (!pendingDesiredConfigId) {
    return { kind: 'no_action', reason: 'nothing is pending' };
  }

  if (!claim) {
    if (operation === 'create') {
      /*
       * A create that left nothing behind. The container was never made, or was
       * made and removed again; either way there is nothing to promote and the
       * candidate describes something that does not exist.
       */
      return { kind: 'discard_pending', desiredConfigId: pendingDesiredConfigId };
    }

    /*
     * A replacement that left nothing at all is not a state the workflow
     * produces: it keeps the original until the replacement runs. Something
     * else happened to this host.
     */
    return { kind: 'needs_attention', reason: 'the container is gone entirely' };
  }

  if (claim.desiredConfigId === pendingDesiredConfigId) {
    return { kind: 'promote_pending', desiredConfigId: pendingDesiredConfigId };
  }

  // It carries the current configuration, so the candidate never took. For a
  // replacement this is the agent's rollback, observed from the outside.
  return { kind: 'discard_pending', desiredConfigId: pendingDesiredConfigId };
}
