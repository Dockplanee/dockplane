/**
 * What starting, stopping or restarting a stack turned out to have done.
 *
 * A pure function, like the classifier for applying a revision, and for the same
 * reason: every case here is a table entry rather than a scenario somebody has
 * to reproduce against a host that lost its connection at the wrong moment. It
 * reads nothing, writes nothing and dispatches nothing.
 *
 * Start and stop answer for themselves. A stack whose services are all running
 * was started, whatever happened to the reply, and one whose services are all
 * stopped was stopped; a mixture is a host nobody may draw a conclusion from.
 *
 * Restart does not answer for itself, and that is the whole difficulty. A stack
 * that was running before and is running now looks the same whether it was
 * restarted or nothing happened at all — the containers keep their identifiers,
 * their images, their configuration and their volumes. The only thing that moves
 * is when Docker last started them, so a restart is judged against what each
 * service looked like immediately before it was dispatched.
 */

export type StackLifecycleKind = 'start' | 'stop' | 'restart';

export type StackLifecycleOutcome =
  /** The stack reached the state that was asked for. */
  | { kind: 'applied' }
  /** Nothing moved. The stack is exactly as it was, so nothing about it changes. */
  | { kind: 'not_applied' }
  /**
   * Some services moved and others did not.
   *
   * Nothing is undone: a container that stopped may be the one holding a lock
   * something else is waiting on, and starting it again to make the result look
   * tidy is a mutation nobody asked for.
   */
  | { kind: 'needs_attention'; reason: string }
  /** The host could not be read well enough to say. Nothing is concluded. */
  | { kind: 'unknown'; reason: string };

/** One service of the stack, as the host shows it now. */
export interface ObservedRuntime {
  readonly serviceName: string;
  readonly containerId: string;
  /** Absent when the resource has no container on the host at all. */
  readonly dockerId: string | null;
  readonly state: string | null;
  /** The revision the container says it is running, from its own label. */
  readonly revisionId: string | null;
  /**
   * When Docker last started it, as Docker reports it.
   *
   * Null when it has never started or could not be read. Absence is never taken
   * as evidence: a restart that cannot be shown to have happened is not one that
   * did.
   */
  readonly startedAt: string | null;
}

/** One service as it was immediately before the operation was dispatched. */
export interface RuntimeFingerprint {
  readonly serviceName: string;
  readonly containerId: string;
  readonly dockerId: string;
  readonly startedAt: string | null;
}

export interface StackLifecycleInput {
  readonly operation: StackLifecycleKind;
  /** The revision that was deployed when the operation was requested. */
  readonly revisionId: string;
  /** The services that revision describes. */
  readonly expectedServices: readonly string[];
  readonly observed: readonly ObservedRuntime[];
  /** Present for a restart, which cannot be judged from the final state alone. */
  readonly fingerprint?: readonly RuntimeFingerprint[];
  /**
   * Whether the host was read completely.
   *
   * Everything below turns on a service being in one state or another, and a
   * pass that stopped halfway establishes neither.
   */
  readonly snapshotComplete: boolean;
}

export function classifyStackLifecycle(input: StackLifecycleInput): StackLifecycleOutcome {
  if (!input.snapshotComplete) {
    return { kind: 'unknown', reason: 'the host was not read completely' };
  }

  const byService = new Map(input.observed.map((service) => [service.serviceName, service]));

  for (const name of input.expectedServices) {
    const service = byService.get(name);

    /*
     * A service the stack should have and the host does not. Nothing here
     * creates one, so this is not a state any lifecycle operation can be said
     * to have produced — it is a stack that is not what it is recorded as.
     */
    if (!service || service.dockerId === null) {
      return { kind: 'needs_attention', reason: `${name} has no container on the host` };
    }

    /*
     * A container running a revision this operation was not for. The host and
     * the record disagree about what is deployed, which no start or stop
     * resolves.
     */
    if (service.revisionId !== null && service.revisionId !== input.revisionId) {
      return { kind: 'needs_attention', reason: `${name} is running another revision` };
    }
  }

  const expected = new Set(input.expectedServices);
  const extra = input.observed.filter(
    (service) => service.dockerId !== null && !expected.has(service.serviceName),
  );

  if (extra.length > 0) {
    return {
      kind: 'needs_attention',
      reason: `the host holds ${extra[0].serviceName}, which this stack's revision does not describe`,
    };
  }

  const services = input.expectedServices.map((name) => byService.get(name)!);
  const running = services.filter((service) => isRunning(service.state));

  if (input.operation === 'stop') {
    if (running.length === 0) {
      return { kind: 'applied' };
    }

    /*
     * Every service still running is a stop that never reached the host. The
     * stack is exactly as it was, which is a state it can be operated from.
     */
    if (running.length === services.length) {
      return { kind: 'not_applied' };
    }

    return { kind: 'needs_attention', reason: 'part of the stack is stopped and part is running' };
  }

  if (input.operation === 'start') {
    if (running.length === services.length) {
      return { kind: 'applied' };
    }

    if (running.length === 0) {
      return { kind: 'not_applied' };
    }

    return { kind: 'needs_attention', reason: 'part of the stack is running and part is not' };
  }

  return restartOutcome(services, input.fingerprint);
}

/**
 * Whether a restart happened, which the final state cannot say on its own.
 *
 * Judged per service against what it was immediately before: the same container,
 * running, and started by Docker later than it had been. A service whose start
 * time cannot be compared — because it was not recorded, because the host did
 * not report one, or because the container is a different one — is not evidence
 * of anything, and a restart nobody can demonstrate is not treated as one.
 */
function restartOutcome(
  services: readonly ObservedRuntime[],
  fingerprint: readonly RuntimeFingerprint[] | undefined,
): StackLifecycleOutcome {
  if (!fingerprint) {
    return { kind: 'unknown', reason: 'there is nothing to compare the restart against' };
  }

  const before = new Map(fingerprint.map((service) => [service.serviceName, service]));

  let restarted = 0;
  let unchanged = 0;

  for (const service of services) {
    if (!isRunning(service.state)) {
      return { kind: 'needs_attention', reason: `${service.serviceName} is not running` };
    }

    const previous = before.get(service.serviceName);

    if (!previous || previous.dockerId !== service.dockerId) {
      return {
        kind: 'unknown',
        reason: `${service.serviceName} is not the container the restart was for`,
      };
    }

    if (previous.startedAt === null || service.startedAt === null) {
      return {
        kind: 'unknown',
        reason: `the host does not say when ${service.serviceName} was started`,
      };
    }

    if (Date.parse(service.startedAt) > Date.parse(previous.startedAt)) {
      restarted += 1;
    } else {
      unchanged += 1;
    }
  }

  if (restarted === services.length) {
    return { kind: 'applied' };
  }

  if (unchanged === services.length) {
    return { kind: 'not_applied' };
  }

  return { kind: 'needs_attention', reason: 'part of the stack was restarted and part was not' };
}

/**
 * Whether Docker's word for a state means the container is up.
 *
 * `restarting` is deliberately not running: a container in a crash loop is one
 * the operator has to see, and calling a start successful because Docker was
 * mid-attempt would hide exactly that.
 */
function isRunning(state: string | null): boolean {
  return state === 'running';
}
