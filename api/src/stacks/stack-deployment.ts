/**
 * What an attempt to apply a revision turned out to have done.
 *
 * Applying a revision moves a stack from whatever it was to what somebody
 * asked for: a stack that has never run, one moving forward, one going back to
 * an older revision, one being converged after a deployment that stopped
 * halfway. All of them end in the same question — what is on the host now? —
 * and it is answered by reading the host and comparing it with the two states
 * that were ever established: the one the stack came from, and the one it was
 * going to.
 *
 * A pure function, for the same reason the container recovery classifier is
 * one: every case below is a table entry rather than a scenario somebody has to
 * reproduce with a broken Docker daemon. It reads nothing, writes nothing and
 * dispatches nothing.
 *
 * There is deliberately no outcome that removes anything. A host holding half
 * of one revision and half of another is something a person has to look at, not
 * something to be tidied away: the containers that are running may already have
 * written to a volume.
 */

export type StackApplyOutcome =
  /** Exactly the target revision is on the host, and running. */
  | { kind: 'finalize_target' }
  /**
   * Exactly the revision the stack came from is on the host. The attempt did
   * not take — either it never started or the agent put the host back — and
   * what the stack is has not changed.
   */
  | { kind: 'finalize_from' }
  /** There was nothing before and there is nothing now. */
  | { kind: 'finalize_not_applied' }
  /** The host is neither one thing nor the other. Nobody may guess. */
  | { kind: 'needs_attention'; reason: string }
  /** The host could not be read well enough to say. Nothing is concluded. */
  | { kind: 'unknown'; reason: string };

/** One container of this stack, as the host shows it. */
export interface ObservedService {
  readonly serviceName: string;
  /** The Dockplane container resource it claims to be. */
  readonly containerId: string;
  /** Absent when the resource has no container on the host. */
  readonly dockerId: string | null;
  readonly state: string | null;
  /** The revision the container says it is running, from its own label. */
  readonly revisionId: string | null;
}

export interface StackApplyInput {
  /** The revision the stack was confirmed to be running. Null before the first. */
  readonly fromRevisionId: string | null;
  readonly targetRevisionId: string;
  /** The services the target revision describes. */
  readonly targetServices: readonly string[];
  /**
   * The services the previous revision described, where they are known.
   *
   * Names only — a revision's summary carries them, which is what makes this
   * answerable without decrypting anything. Null when the stack came from
   * nothing.
   */
  readonly fromServices: readonly string[] | null;
  /** Every container currently attributed to this stack. */
  readonly observed: readonly ObservedService[];
  /**
   * Whether the discovery this was read from finished.
   *
   * Every conclusion here turns on something being present or absent, and a
   * pass that stopped halfway cannot establish either.
   */
  readonly snapshotComplete: boolean;
}

export function classifyStackApply(input: StackApplyInput): StackApplyOutcome {
  if (!input.snapshotComplete) {
    return { kind: 'unknown', reason: 'the host was not read completely' };
  }

  const live = input.observed.filter((service) => service.dockerId !== null);

  /*
   * Two containers claiming one service outranks everything else.
   *
   * It is what a crash between creating the target and removing what it
   * replaced leaves behind, and it is tempting to resolve: one of them carries
   * the target revision and looks like the winner. But which is the real
   * container was never established, and being wrong removes a workload.
   */
  const services = new Set<string>();

  for (const service of live) {
    if (services.has(service.serviceName)) {
      return {
        kind: 'needs_attention',
        reason: `two containers are service ${service.serviceName}`,
      };
    }

    services.add(service.serviceName);
  }

  if (live.length === 0) {
    /*
     * Nothing of this stack is on the host. That is the whole answer when there
     * was nothing before; when there was something, the stack has lost what it
     * had and that is not an outcome to record as an ordinary failure.
     */
    return input.fromRevisionId === null
      ? { kind: 'finalize_not_applied' }
      : { kind: 'needs_attention', reason: 'the stack that was running is gone' };
  }

  if (matches(live, input.targetServices, input.targetRevisionId, true)) {
    return { kind: 'finalize_target' };
  }

  /*
   * The revision the stack came from, exactly as it was — including a service
   * an operator had deliberately stopped. Running is the bar for a deployment
   * to have succeeded; it is not the bar for the host being untouched.
   */
  if (
    input.fromRevisionId !== null &&
    input.fromServices !== null &&
    matches(live, input.fromServices, input.fromRevisionId, false)
  ) {
    return { kind: 'finalize_from' };
  }

  return {
    kind: 'needs_attention',
    reason: `${live.length} containers are running and they are not one revision`,
  };
}

/**
 * Whether the host holds exactly this revision and nothing else.
 *
 * Every service the revision describes is there, each says it is that revision,
 * and nothing else of this stack is on the host — a container from an older
 * revision that survived is the difference between a clean state and one
 * somebody has to look at. Whether they have to be running depends on which
 * side is being tested: a deployment succeeds only if they are, and a host that
 * was left untouched is untouched whatever state its containers were in.
 */
function matches(
  live: readonly ObservedService[],
  expected: readonly string[],
  revisionId: string,
  requireRunning: boolean,
): boolean {
  if (live.length !== expected.length) {
    return false;
  }

  const wanted = new Set(expected);

  return live.every(
    (service) =>
      wanted.has(service.serviceName) &&
      service.revisionId === revisionId &&
      (!requireRunning || service.state === 'running'),
  );
}
