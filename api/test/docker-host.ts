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
