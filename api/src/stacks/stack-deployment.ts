/**
 * What a deployment turned out to have done.
 *
 * A stack deployment creates several containers on a host, one after another,
 * and any of them can be the one that fails. The answer is established by
 * reading the host afterwards and comparing it with what the deployment was
 * supposed to produce — never from what the agent said, which is a report about
 * a machine rather than the machine.
 *
 * A pure function, for the same reason the container recovery classifier is
 * one: every case below is a test rather than a scenario somebody has to
 * reproduce with a broken Docker daemon. It reads nothing, writes nothing and
 * dispatches nothing.
 *
 * There is deliberately no outcome that removes anything. A deployment that
 * created two of three containers has produced something a person has to look
 * at, not something to be tidied away — the two that started may already have
 * written to a volume.
 */

export type StackDeploymentOutcome =
  /** Every service the revision describes is running. */
  | { kind: 'succeeded' }
  /**
   * Nothing was created. The host is as it was, so the attempt is over and the
   * stack may be deployed again once whatever was wrong is fixed.
   */
  | { kind: 'failed'; reason: string }
  /**
   * Some of it exists and some of it does not. Nothing is removed and the stack
   * is not recorded as deployed: a person decides what happens next.
   */
  | { kind: 'needs_attention'; reason: string }
  /** The host could not be read well enough to say. Nothing is concluded. */
  | { kind: 'unknown'; reason: string };

/** One service of the stack, as the host shows it. */
export interface ObservedService {
  readonly serviceName: string;
  /** The Dockplane container resource allocated for this service. */
  readonly containerId: string;
  /** Absent when no container on the host claims that resource. */
  readonly dockerId: string | null;
  readonly state: string | null;
}

export interface StackDeploymentInput {
  readonly services: readonly ObservedService[];
  /**
   * Whether the discovery this was read from finished.
   *
   * Every conclusion here turns on something being present or absent, and a
   * pass that stopped halfway cannot establish either.
   */
  readonly snapshotComplete: boolean;
}

export function classifyStackDeployment(input: StackDeploymentInput): StackDeploymentOutcome {
  if (!input.snapshotComplete) {
    return { kind: 'unknown', reason: 'the host was not read completely' };
  }

  if (input.services.length === 0) {
    return { kind: 'unknown', reason: 'the deployment describes no services' };
  }

  const present = input.services.filter((service) => service.dockerId !== null);

  /*
   * Running, not healthy.
   *
   * A health check belongs to the container and is reported as observed state
   * afterwards. Making a deployment's success wait for one would make it depend
   * on a timeout somebody chose in a Compose file, and a database that takes a
   * minute to warm up would look like a failed deployment.
   */
  const running = present.filter((service) => service.state === 'running');

  if (running.length === input.services.length) {
    return { kind: 'succeeded' };
  }

  if (present.length === 0) {
    return { kind: 'failed', reason: 'no container of this stack exists on the host' };
  }

  return {
    kind: 'needs_attention',
    reason: `${running.length} of ${input.services.length} services are running`,
  };
}
