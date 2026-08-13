/**
 * A Docker host, as far as the control server can tell.
 *
 * Not a mock of the agent's replies but a small model of what those replies
 * describe: a set of containers that a create adds to, a replace exchanges and
 * a remove takes away. Everything the server concludes afterwards comes from
 * listing it again.
 *
 * That is the point. Reconciliation decides what happened by reading the host,
 * so a test whose agent merely says "success" would be testing the reply rather
 * than the mechanism. Here a create that the host quietly did not perform, or a
 * replacement that left the original running, is a thing the test can arrange —
 * and the server has to notice.
 */
export interface FakeContainer {
  dockerId: string;
  name: string;
  image: string;
  state: string;
  labels: Record<string, string>;
}

export class FakeDockerHost {
  readonly containers = new Map<string, FakeContainer>();

  /** Capabilities the host was asked for, in order. */
  readonly received: string[] = [];

  /** Set to make the host accept an operation and not perform it. */
  silentlyIgnore = new Set<string>();

  /** Set to make the host refuse an operation the way a real one would. */
  failWith = new Map<string, { code: string; message: string }>();

  /**
   * Stack plans this host was sent, in order.
   *
   * Kept so a test can assert what a plan carried — a plan legitimately holds
   * resolved secrets, which is exactly why nothing else may.
   */
  readonly stackPlans: StackPlan[] = [];

  /** Volumes and networks a deployment asked for, by the name Docker uses. */
  readonly volumes = new Set<string>();
  readonly networks = new Set<string>();

  /** Services this host creates and does not start. */
  readonly wontStart = new Set<string>();

  /** Services this host refuses outright, stopping the deployment there. */
  readonly wontCreate = new Set<string>();

  /**
   * Set to make the host fail an attempt and not put back what it moved.
   *
   * The state the server may not resolve on its own: neither the revision that
   * was running nor the one that was being applied.
   */
  leaveHalfApplied = false;

  private next = 0;

  /** A container that was already there when Dockplane arrived. */
  seed(name: string, labels: Record<string, string> = {}): FakeContainer {
    const container: FakeContainer = {
      dockerId: this.id(),
      name,
      image: 'nginx:1.27',
      state: 'running',
      labels,
    };

    this.containers.set(container.dockerId, container);

    return container;
  }

  list() {
    return [...this.containers.values()].map((container) => ({
      dockerId: container.dockerId,
      name: container.name,
      image: container.image,
      imageId: 'sha256:abc',
      state: container.state,
      status: container.state === 'running' ? 'Up 1 second' : 'Exited (0)',
      health: 'none',
      createdAt: new Date().toISOString(),
      labels: container.labels,
    }));
  }

  /** Answers one capability, changing the host where the capability does. */
  handle(capability: string, payload: Record<string, unknown>): unknown {
    this.received.push(capability);

    const failure = this.failWith.get(capability);

    if (failure) {
      throw failure;
    }

    switch (capability) {
      case 'host.inventory':
        return { hostname: 'docker-01', dockerVersion: '29.0.0', observedAt: iso() };
      case 'host.metrics':
        return { cpuPercent: 3 };
      case 'compose.list':
        return { projects: [] };
      case 'container.list':
        return { containers: this.list() };
      case 'container.inspect':
        return { container: this.inspect(String(payload.containerId)) };
      case 'container.start':
        return this.setState(String(payload.containerId), 'running');
      case 'container.stop':
        return this.setState(String(payload.containerId), 'exited');
      case 'container.restart':
        return this.setState(String(payload.containerId), 'running');
      case 'container.create':
        return this.create(payload);
      case 'container.replace':
        return this.replace(payload);
      case 'container.remove':
        return this.remove(payload);
      case 'stack.deploy':
        return this.applyStack(payload);
      default:
        throw { code: 'CAPABILITY_UNSUPPORTED', message: `no such capability: ${capability}` };
    }
  }

  private setState(dockerId: string, state: string) {
    const container = this.containers.get(dockerId);

    if (!container) {
      throw { code: 'CONTAINER_NOT_FOUND', message: 'No such container.' };
    }

    container.state = state;

    return { dockerId, state, health: 'none', observedAt: iso() };
  }

  private create(payload: Record<string, unknown>) {
    const spec = payload.spec as { name: string; image: string };

    if (this.silentlyIgnore.has('container.create')) {
      return { dockerId: 'never-created', state: 'running', observedAt: iso() };
    }

    const container: FakeContainer = {
      dockerId: this.id(),
      name: spec.name,
      image: spec.image,
      state: 'running',
      labels: this.identity(payload),
    };

    this.containers.set(container.dockerId, container);

    return { dockerId: container.dockerId, state: 'running', observedAt: iso() };
  }

  private replace(payload: Record<string, unknown>) {
    const spec = payload.spec as { name: string; image: string };
    const original = this.containers.get(String(payload.dockerId));

    if (this.silentlyIgnore.has('container.replace')) {
      // What a rollback leaves: the original, still itself.
      return { dockerId: original?.dockerId, rolledBack: true, observedAt: iso() };
    }

    this.containers.delete(String(payload.dockerId));

    const replacement: FakeContainer = {
      dockerId: this.id(),
      name: spec.name,
      image: spec.image,
      state: 'running',
      labels: this.identity(payload),
    };

    this.containers.set(replacement.dockerId, replacement);

    return {
      dockerId: replacement.dockerId,
      previousContainerId: original?.dockerId,
      state: 'running',
      observedAt: iso(),
    };
  }

  private remove(payload: Record<string, unknown>) {
    if (this.silentlyIgnore.has('container.remove')) {
      return { removed: false, observedAt: iso() };
    }

    this.containers.delete(String(payload.dockerId));

    return { removed: true, observedAt: iso() };
  }

  /**
   * Deploys a stack the way the agent does.
   *
   * Dependencies first, stopping at the first service that fails, and never
   * removing anything that was already created — the shape the real agent has,
   * because the server's conclusions are drawn from what is left behind.
   */
  /**
   * Applies a revision the way the agent does.
   *
   * The shape matters more than the detail: what the stack already has is moved
   * aside before anything new is built, the new containers are created in
   * dependency order, and if one of them fails the old ones are put back
   * exactly as they were. The server draws its conclusions from listing this
   * host afterwards, so a test can arrange a host that half applied a revision
   * and the server has to notice.
   */
  private applyStack(payload: Record<string, unknown>) {
    const plan = payload.plan as StackPlan;

    this.stackPlans.push(plan);

    if (this.silentlyIgnore.has('stack.deploy')) {
      return {
        stackId: plan.stackId,
        revisionId: plan.revisionId,
        outcome: 'target_applied',
        services: [],
        complete: false,
      };
    }

    for (const network of plan.networks ?? []) {
      this.networks.add(network.dockerName);
    }

    for (const volume of plan.volumes ?? []) {
      this.volumes.add(volume.dockerName);
    }

    // What the stack has now, which is the way back if the target fails.
    const candidates = [...this.containers.values()].filter(
      (container) => container.labels['io.dockplane.stack-id'] === plan.stackId,
    );

    /*
     * The real agent refuses to apply anything over a host where two containers
     * claim one service: choosing between them is choosing which of somebody's
     * containers to destroy. Modelled here because the server's handling of
     * that refusal is what these tests are about.
     */
    const claims = new Set<string>();

    for (const candidate of candidates) {
      const service = candidate.labels['io.dockplane.stack-service'];

      if (claims.has(service)) {
        throw {
          code: 'STACK_STATE_AMBIGUOUS',
          message: `more than one container is service ${service}`,
        };
      }

      claims.add(service);
    }

    for (const candidate of candidates) {
      this.containers.delete(candidate.dockerId);
    }

    const services: Record<string, unknown>[] = [];
    const built: FakeContainer[] = [];

    for (const service of order(plan)) {
      if (this.wontCreate.has(service.serviceName)) {
        services.push({
          serviceName: service.serviceName,
          containerId: service.containerId,
          errorCode: 'IMAGE_PULL_FAILED',
        });

        return this.undoStack(plan, built, candidates, services, service.serviceName);
      }

      const state = this.wontStart.has(service.serviceName) ? 'exited' : 'running';

      const container: FakeContainer = {
        dockerId: this.id(),
        name: service.containerName,
        image: service.spec.image,
        state,
        labels: {
          ...(service.spec.labels ?? {}),
          'io.dockplane.managed': 'true',
          'io.dockplane.container-id': service.containerId,
          'io.dockplane.stack-id': plan.stackId,
          'io.dockplane.stack-revision-id': plan.revisionId,
          'io.dockplane.stack-service': service.serviceName,
        },
      };

      this.containers.set(container.dockerId, container);
      built.push(container);

      services.push({
        serviceName: service.serviceName,
        containerId: service.containerId,
        dockerId: container.dockerId,
        state,
        ...(state === 'running' ? {} : { errorCode: 'CONTAINER_NOT_RUNNING' }),
      });

      if (state !== 'running') {
        return this.undoStack(plan, built, candidates, services, service.serviceName);
      }
    }

    return {
      stackId: plan.stackId,
      revisionId: plan.revisionId,
      outcome: 'target_applied',
      services,
      complete: true,
      observedAt: iso(),
    };
  }

  /**
   * Puts back what the attempt moved aside.
   *
   * `leaveHalfApplied` is the state nobody can put back: what was built stays
   * and what it replaced does not come back, which is what a host looks like
   * when the agent's own restore did not work.
   */
  private undoStack(
    plan: StackPlan,
    built: FakeContainer[],
    candidates: FakeContainer[],
    services: Record<string, unknown>[],
    failedService: string,
  ) {
    if (!this.leaveHalfApplied) {
      for (const container of built) {
        this.containers.delete(container.dockerId);
      }

      for (const candidate of candidates) {
        this.containers.set(candidate.dockerId, candidate);
      }
    }

    return {
      stackId: plan.stackId,
      revisionId: plan.revisionId,
      outcome: this.leaveHalfApplied
        ? 'apply_failed_rollback_incomplete'
        : 'apply_failed_rollback_succeeded',
      services,
      complete: false,
      failedService,
      observedAt: iso(),
    };
  }

  /** The labels the agent applies from what the server resolved, never from the spec. */
  private identity(payload: Record<string, unknown>): Record<string, string> {
    const spec = payload.spec as { labels?: Record<string, string> };

    return {
      ...(spec.labels ?? {}),
      'io.dockplane.managed': 'true',
      ...(payload.containerId ? { 'io.dockplane.container-id': String(payload.containerId) } : {}),
      ...(payload.desiredConfigId
        ? { 'io.dockplane.desired-config-id': String(payload.desiredConfigId) }
        : {}),
    };
  }

  private inspect(dockerId: string) {
    const container = this.containers.get(dockerId);

    return container
      ? {
          dockerId: container.dockerId,
          name: container.name,
          image: container.image,
          state: container.state,
          status: 'Up 1 second',
          health: 'none',
          restartCount: 0,
          ports: [],
          networks: [],
          mounts: [],
          labels: container.labels,
        }
      : undefined;
  }

  private id(): string {
    this.next += 1;

    return `docker${String(this.next).padStart(4, '0')}`;
  }

  /** The container carrying a Dockplane identity, if exactly one does. */
  claiming(containerId: string): FakeContainer | undefined {
    const claims = [...this.containers.values()].filter(
      (container) => container.labels['io.dockplane.container-id'] === containerId,
    );

    return claims.length === 1 ? claims[0] : undefined;
  }
}

function iso(): string {
  return new Date().toISOString();
}

export interface StackPlan {
  planVersion: number;
  stackId: string;
  revisionId: string;
  projectName: string;
  networks: { name: string; dockerName: string }[];
  volumes: { name: string; dockerName: string }[];
  services: {
    serviceName: string;
    containerId: string;
    containerName: string;
    dependsOn?: string[];
    spec: {
      image: string;
      labels?: Record<string, string>;
      env?: { key: string; value: string }[];
    };
  }[];
}

/** Dependencies before dependants, which is the order the agent starts in. */
function order(plan: StackPlan): StackPlan['services'] {
  const remaining = [...plan.services];
  const started = new Set<string>();
  const sorted: StackPlan['services'] = [];

  while (remaining.length > 0) {
    const index = remaining.findIndex((service) =>
      (service.dependsOn ?? []).every((dependency) => started.has(dependency)),
    );

    if (index === -1) {
      // A cycle the server should never have sent. Deploy them as they came.
      return [...sorted, ...remaining];
    }

    const [next] = remaining.splice(index, 1);

    started.add(next.serviceName);
    sorted.push(next);
  }

  return sorted;
}
