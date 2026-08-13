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
  /**
   * When this container was last started, as Docker reports it.
   *
   * Modelled because the real engine behaves this way and the product depends
   * on it: restarting a container changes nothing else an observer can see, so
   * this is the only evidence that a restart happened at all.
   */
  startedAt?: string;
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

  /** Services that refuse to stop, which is how a stack ends up half stopped. */
  readonly wontStop = new Set<string>();

  /** Services that refuse to be removed, which is how a delete ends up partial. */
  readonly wontRemove = new Set<string>();

  /** Every lifecycle operation this host was asked to perform, in order. */
  readonly stackOperations: { operation: string; plan: StackLifecyclePlan }[] = [];

  private starts = 0;

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
      case 'stack.start':
        return this.runStackLifecycle('start', payload);
      case 'stack.stop':
        return this.runStackLifecycle('stop', payload);
      case 'stack.restart':
        return this.runStackLifecycle('restart', payload);
      case 'stack.remove':
        return this.removeStack(payload);
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
        // A running container always has one, which is what a restart later
        // has to be able to be compared against.
        ...(state === 'running' ? { startedAt: this.nextStart() } : {}),
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

  /**
   * Starting, stopping and restarting a deployed stack.
   *
   * The real agent's rules, because the server's behaviour is only meaningful
   * against them: the containers are found by the identity Dockplane gave them,
   * a service that is missing or claimed twice stops the operation before
   * anything moves, and services go up in dependency order and down in reverse.
   */
  private runStackLifecycle(operation: string, payload: Record<string, unknown>) {
    const plan = payload.plan as StackLifecyclePlan;

    this.stackOperations.push({ operation, plan });

    const resolved = new Map<string, FakeContainer>();

    for (const service of plan.services) {
      const claims = [...this.containers.values()].filter(
        (container) =>
          container.labels['io.dockplane.stack-id'] === plan.stackId &&
          container.labels['io.dockplane.stack-service'] === service.serviceName,
      );

      if (claims.length > 1) {
        throw {
          code: 'STACK_STATE_AMBIGUOUS',
          message: `more than one container is service ${service.serviceName}`,
        };
      }

      if (claims.length === 0) {
        throw {
          code: 'STACK_SERVICE_MISSING',
          message: `${service.serviceName} is not on the host`,
        };
      }

      if (claims[0].labels['io.dockplane.container-id'] !== service.containerId) {
        throw {
          code: 'STACK_STATE_AMBIGUOUS',
          message: `${service.serviceName} is held by a container with another identity`,
        };
      }

      resolved.set(service.serviceName, claims[0]);
    }

    const order = lifecycleOrder(plan);
    let moved = false;

    if (operation === 'stop' || operation === 'restart') {
      for (const name of [...order].reverse()) {
        const container = resolved.get(name)!;

        if (container.state !== 'running') {
          continue;
        }

        if (this.wontStop.has(name)) {
          return this.partialLifecycle(operation, plan, resolved, name, moved);
        }

        container.state = 'exited';
        moved = true;
      }
    }

    if (operation === 'start' || operation === 'restart') {
      for (const name of order) {
        const container = resolved.get(name)!;

        if (container.state === 'running') {
          continue;
        }

        if (this.wontStart.has(name)) {
          return this.partialLifecycle(operation, plan, resolved, name, moved);
        }

        container.state = 'running';
        container.startedAt = this.nextStart();
        moved = true;
      }
    }

    return {
      stackId: plan.stackId,
      revisionId: plan.revisionId,
      operation,
      outcome: 'completed',
      services: [...resolved.entries()].map(([serviceName, container]) => ({
        serviceName,
        dockerId: container.dockerId,
        state: container.state,
        startedAt: container.startedAt,
      })),
    };
  }

  /**
   * An operation that stopped partway.
   *
   * Nothing is put back: the point of the state is that the host is neither
   * where it was nor where it was going, and the server has to establish that
   * for itself.
   */
  private partialLifecycle(
    operation: string,
    plan: StackLifecyclePlan,
    resolved: Map<string, FakeContainer>,
    failedService: string,
    moved: boolean,
  ): never {
    throw {
      code: moved ? 'STACK_LIFECYCLE_INCOMPLETE' : 'DOCKER_OPERATION_FAILED',
      message: `${failedService} would not move`,
      detail: {
        stackId: plan.stackId,
        operation,
        services: [...resolved.keys()],
      },
    };
  }

  /**
   * Removing a stack's containers, the way the agent does.
   *
   * Ownership is proven for every expected service before the first container
   * goes, and no removal ever asks Docker to take a volume with it — the two
   * rules this operation exists to keep.
   */
  private removeStack(payload: Record<string, unknown>) {
    const plan = payload.plan as StackLifecyclePlan;

    this.stackOperations.push({ operation: 'remove', plan });

    const resolved = new Map<string, FakeContainer>();

    for (const service of plan.services) {
      const claims = [...this.containers.values()].filter(
        (container) =>
          container.labels['io.dockplane.stack-id'] === plan.stackId &&
          container.labels['io.dockplane.stack-service'] === service.serviceName,
      );

      if (claims.length > 1) {
        throw {
          code: 'STACK_STATE_AMBIGUOUS',
          message: `more than one container is service ${service.serviceName}`,
        };
      }

      if (claims.length === 0) {
        throw { code: 'STACK_SERVICE_MISSING', message: `${service.serviceName} is not on the host` };
      }

      if (claims[0].labels['io.dockplane.container-id'] !== service.containerId) {
        throw {
          code: 'STACK_STATE_AMBIGUOUS',
          message: `${service.serviceName} is held by a container with another identity`,
        };
      }

      resolved.set(service.serviceName, claims[0]);
    }

    const removed: { serviceName: string; dockerId: string }[] = [];

    for (const name of [...lifecycleOrder(plan)].reverse()) {
      const container = resolved.get(name)!;

      if (this.wontRemove.has(name)) {
        throw {
          code: removed.length > 0 ? 'STACK_REMOVE_INCOMPLETE' : 'DOCKER_OPERATION_FAILED',
          message: `${name} would not be removed`,
        };
      }

      this.containers.delete(container.dockerId);
      removed.push({ serviceName: name, dockerId: container.dockerId });
    }

    return { stackId: plan.stackId, revisionId: plan.revisionId, outcome: 'removed', removed };
  }

  /** Monotonic, as Docker's own start times are. */
  private nextStart(): string {
    this.starts += 1;

    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.starts)).toISOString();
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
          startedAt: container.startedAt,
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

/** What the server sends to start, stop or restart a deployed stack. */
export interface StackLifecyclePlan {
  planVersion: number;
  stackId: string;
  revisionId: string;
  services: { serviceName: string; containerId: string; dependsOn?: string[] }[];
}

/** The order services are started in, dependencies first. */
function lifecycleOrder(plan: StackLifecyclePlan): string[] {
  const remaining = [...plan.services];
  const started = new Set<string>();
  const sorted: string[] = [];

  while (remaining.length > 0) {
    const index = remaining.findIndex((service) =>
      (service.dependsOn ?? []).every((dependency) => started.has(dependency)),
    );

    if (index === -1) {
      return [...sorted, ...remaining.map((service) => service.serviceName)];
    }

    const [next] = remaining.splice(index, 1);

    started.add(next.serviceName);
    sorted.push(next.serviceName);
  }

  return sorted;
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
