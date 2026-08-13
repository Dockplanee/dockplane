import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { Logger } from 'pino';

import { AgentDispatchService } from '../agents/agent-dispatch.service';
import { AgentConnectionManager } from '../agents/connection-manager.service';
import { AppError } from '../common/errors';
import { LOGGER } from '../config/tokens';
import { Database } from '../database/database';
import { agents, composeProjects, containers } from '../database/schema';

/**
 * How long a stored detail counts as current.
 *
 * A detail view is opened repeatedly — a refresh, a second operator, a browser
 * tab left open. Without a window, every one of those would reach the host.
 */
const FRESH_FOR_MS = 10_000;

/** Sanitised container detail. Every field is chosen; nothing is passed through. */
export interface ContainerDetail {
  dockerId: string;
  name: string;
  image: string;
  imageId?: string;
  state: string;
  status: string;
  health: string;
  restartCount: number;
  restartPolicy?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  ports: { containerPort: number; protocol: string; hostPort?: string; hostIp?: string }[];
  networks: string[];
  mounts: { type: string; name?: string; readOnly: boolean }[];
  limits?: { memoryBytes?: number; nanoCpus?: number; pidsLimit?: number };
  labels: Record<string, string>;
}

/** Sanitised Compose service detail. */
export interface ComposeServiceDetail {
  name: string;
  containerIds: string[];
  running: number;
  total: number;
  state: string;
}

/**
 * On-demand detail.
 *
 * Discovery keeps a summary of every container and project. Detail is read only
 * when someone asks for it, because inspecting every container on every host on
 * a schedule would put load on a fleet for data nobody is looking at.
 *
 * A request reaches the host through the same dispatch layer as everything
 * else. The capability is named here, from the catalog; a caller supplies an
 * identifier and nothing more.
 */
@Injectable()
export class DetailService {
  /**
   * Dispatches in flight, keyed by record.
   *
   * Concurrent requests for the same container share one round trip rather than
   * each opening their own. Combined with the freshness window, a page that
   * polls cannot turn into load on the managed host.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Database,
    private readonly dispatch: AgentDispatchService,
    private readonly connections: AgentConnectionManager,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Reads one container in detail.
   *
   * The stored projection is returned when it is recent, refreshed from the
   * host when it is not, and returned stale when the host cannot be reached.
   * Only when there is nothing stored and no way to ask does this fail.
   *
   * `force` asks the host again whatever is stored. It exists for the moment
   * after an operation changed the container: a projection read seconds earlier
   * describes the container as it was before, and reporting that as the result
   * of a start would tell an operator their action did nothing.
   */
  async containerDetail(
    containerId: string,
    options: { force?: boolean } = {},
  ): Promise<{
    detail: ContainerDetail | null;
    observedAt: Date | null;
    stale: boolean;
  }> {
    const [row] = await this.db.client
      .select()
      .from(containers)
      .where(eq(containers.id, containerId));

    if (!row) {
      throw AppError.notFound('CONTAINER_NOT_FOUND', 'The container does not exist.');
    }

    /*
     * A resource whose create has not produced a container. There is nothing on
     * the host to inspect, and no identifier to inspect it by.
     */
    if (!row.dockerId) {
      throw AppError.notFound('CONTAINER_NOT_FOUND', 'The container does not exist.');
    }

    const stored = (row.detail as ContainerDetail | null) ?? null;

    if (!options.force && stored && this.isFresh(row.detailObservedAt)) {
      return { detail: stored, observedAt: row.detailObservedAt, stale: false };
    }

    const agentId = await this.connectedAgent(row.hostId);

    if (!agentId) {
      return this.offline(stored, row.detailObservedAt, 'CONTAINER_DETAIL_UNAVAILABLE');
    }

    try {
      /*
       * The shared unit of work is refreshing the record, not just asking the
       * host. Releasing other callers as soon as the reply arrived would let one
       * of them read the row before it was written and ask the host all over
       * again, which is the flood this exists to prevent.
       */
      const key = options.force ? `container:${containerId}:force` : `container:${containerId}`;

      const refreshed = await this.coalesce(key, async () => {
        // Another request may have refreshed this while it was queued.
        const [current] = await this.db.client
          .select({ detail: containers.detail, detailObservedAt: containers.detailObservedAt })
          .from(containers)
          .where(eq(containers.id, containerId));

        if (!options.force && current?.detail && this.isFresh(current.detailObservedAt)) {
          return {
            detail: current.detail as ContainerDetail,
            observedAt: current.detailObservedAt,
          };
        }

        const payload = await this.dispatch.request<{ container?: unknown }>(
          agentId,
          'container.inspect',
          { containerId: row.dockerId },
        );

        const detail = normaliseContainerDetail(payload?.container);

        if (!detail) {
          return null;
        }

        const observedAt = new Date();

        await this.db.client
          .update(containers)
          .set({
            detail,
            detailObservedAt: observedAt,
            state: detail.state || row.state,
            health: detail.health || row.health,
            restartCount: detail.restartCount ?? row.restartCount,
            updatedAt: observedAt,
          })
          .where(eq(containers.id, containerId));

        return { detail, observedAt };
      });

      if (!refreshed) {
        return this.offline(stored, row.detailObservedAt, 'CONTAINER_DETAIL_UNAVAILABLE');
      }

      return { detail: refreshed.detail, observedAt: refreshed.observedAt, stale: false };
    } catch (error) {
      /*
       * The host is authoritative about what is running on it. If it says the
       * container is gone, that answer is newer than anything stored, so it is
       * reported as gone rather than papered over with a cached view.
       */
      if (error instanceof AppError && error.code === 'CONTAINER_NOT_FOUND') {
        await this.db.client.delete(containers).where(eq(containers.id, containerId));

        throw AppError.notFound('CONTAINER_NOT_FOUND', 'The container no longer exists.');
      }

      this.logger.warn(
        {
          event: 'container_detail_failed',
          containerId,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'could not read container detail from the host',
      );

      return this.offline(stored, row.detailObservedAt, 'CONTAINER_DETAIL_UNAVAILABLE');
    }
  }

  /** Reads one Compose project in detail, under the same rules. */
  async projectDetail(projectId: string): Promise<{
    services: ComposeServiceDetail[];
    status: string;
    serviceCount: number;
    runningCount: number;
    observedAt: Date | null;
    stale: boolean;
  }> {
    const [row] = await this.db.client
      .select()
      .from(composeProjects)
      .where(eq(composeProjects.id, projectId));

    if (!row) {
      throw AppError.notFound('COMPOSE_PROJECT_NOT_FOUND', 'The Compose project does not exist.');
    }

    const stored = normaliseServices(row.services);

    const summary = {
      status: row.status,
      serviceCount: row.serviceCount,
      runningCount: row.runningCount,
    };

    /*
     * Discovery stores the service list it read from `compose.list`, so a
     * project that has never been inspected still has something to show. Only a
     * project with nothing recorded at all has no answer to give.
     */
    const everObserved = row.services !== null;

    if (row.detailObservedAt && this.isFresh(row.detailObservedAt)) {
      return { services: stored, ...summary, observedAt: row.detailObservedAt, stale: false };
    }

    const agentId = await this.connectedAgent(row.hostId);

    if (!agentId) {
      return this.offlineProject(stored, summary, row.detailObservedAt, everObserved);
    }

    try {
      const outcome = await this.coalesce(`compose:${projectId}`, async () => {
        const [current] = await this.db.client
          .select({
            services: composeProjects.services,
            status: composeProjects.status,
            serviceCount: composeProjects.serviceCount,
            runningCount: composeProjects.runningCount,
            detailObservedAt: composeProjects.detailObservedAt,
          })
          .from(composeProjects)
          .where(eq(composeProjects.id, projectId));

        if (current && this.isFresh(current.detailObservedAt)) {
          return {
            services: normaliseServices(current.services),
            status: current.status,
            serviceCount: current.serviceCount,
            runningCount: current.runningCount,
            observedAt: current.detailObservedAt,
          };
        }

        const payload = await this.dispatch.request<{ project?: Record<string, unknown> }>(
          agentId,
          'compose.inspect',
          { projectName: row.projectName },
        );

        const project = payload?.project;

        if (!project) {
          return null;
        }

        const services = normaliseServices(project.services);
        const observedAt = new Date();

        const values = {
          status: typeof project.status === 'string' ? project.status : summary.status,
          serviceCount:
            typeof project.serviceCount === 'number' ? project.serviceCount : services.length,
          runningCount:
            typeof project.runningCount === 'number' ? project.runningCount : summary.runningCount,
        };

        await this.db.client
          .update(composeProjects)
          .set({ services, detailObservedAt: observedAt, ...values, updatedAt: observedAt })
          .where(eq(composeProjects.id, projectId));

        return { services, ...values, observedAt };
      });

      if (!outcome) {
        return this.offlineProject(stored, summary, row.detailObservedAt, everObserved);
      }

      return { ...outcome, stale: false };
    } catch (error) {
      if (error instanceof AppError && error.code === 'COMPOSE_PROJECT_NOT_FOUND') {
        throw AppError.notFound(
          'COMPOSE_PROJECT_NOT_FOUND',
          'The Compose project no longer exists.',
        );
      }

      this.logger.warn(
        {
          event: 'compose_detail_failed',
          projectId,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'could not read Compose detail from the host',
      );

      return this.offlineProject(stored, summary, row.detailObservedAt, everObserved);
    }
  }

  private isFresh(observedAt: Date | null): boolean {
    return observedAt !== null && Date.now() - observedAt.getTime() < FRESH_FOR_MS;
  }

  /**
   * Finds the agent that can answer for a host.
   *
   * A revoked agent is never dispatched to, however recently it was seen. The
   * connection manager is then asked whether it is actually there: the registry
   * records what should be true, the connection is what is.
   */
  private async connectedAgent(hostId: string): Promise<string | undefined> {
    const [agent] = await this.db.client
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.hostId, hostId), isNull(agents.revokedAt)));

    if (!agent) {
      return undefined;
    }

    return this.connections.isConnected(agent.id) ? agent.id : undefined;
  }

  /**
   * Shares one dispatch between concurrent callers.
   *
   * Without this, opening the same container in three tabs would send three
   * requests to a host that is being asked the same question.
   */
  private async coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;

    if (existing) {
      return existing;
    }

    const pending = run().finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, pending);

    return pending;
  }

  private offline(
    stored: ContainerDetail | null,
    observedAt: Date | null,
    code: 'CONTAINER_DETAIL_UNAVAILABLE',
  ): { detail: ContainerDetail; observedAt: Date | null; stale: true } {
    if (!stored) {
      throw AppError.conflict(
        code,
        'The host has not been reachable since this container was discovered, so no detail has ever been read.',
      );
    }

    return { detail: stored, observedAt, stale: true };
  }

  private offlineProject(
    services: ComposeServiceDetail[],
    summary: { status: string; serviceCount: number; runningCount: number },
    observedAt: Date | null,
    everObserved: boolean,
  ) {
    if (!everObserved) {
      throw AppError.conflict(
        'COMPOSE_DETAIL_UNAVAILABLE',
        'The host has not been reachable since this project was discovered, so no detail has ever been read.',
      );
    }

    return { services, ...summary, observedAt, stale: true as const };
  }
}

/**
 * Builds the stored projection field by field.
 *
 * The agent already refuses to send environment values, credentials, the
 * configured command and host paths. This rebuilds the record from the fields
 * the product defines anyway, so an agent that reported more than it should —
 * because it was modified, or compromised — still cannot put that data into the
 * control server's database.
 */
export function normaliseContainerDetail(value: unknown): ContainerDetail | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const raw = value as Record<string, unknown>;

  if (typeof raw.dockerId !== 'string' || raw.dockerId === '') {
    return null;
  }

  const detail: ContainerDetail = {
    dockerId: raw.dockerId,
    name: text(raw.name) ?? '',
    image: text(raw.image) ?? '',
    state: text(raw.state) ?? 'unknown',
    status: text(raw.status) ?? 'unknown',
    health: text(raw.health) ?? 'none',
    restartCount: number(raw.restartCount) ?? 0,
    ports: ports(raw.ports),
    networks: strings(raw.networks),
    mounts: mounts(raw.mounts),
    labels: composeLabels(raw.labels),
  };

  assign(detail, 'imageId', text(raw.imageId));
  assign(detail, 'restartPolicy', text(raw.restartPolicy));
  assign(detail, 'createdAt', timestamp(raw.createdAt));
  assign(detail, 'startedAt', timestamp(raw.startedAt));
  assign(detail, 'finishedAt', timestamp(raw.finishedAt));
  assign(detail, 'exitCode', number(raw.exitCode));

  const constraints = limits(raw.limits);

  if (constraints) {
    detail.limits = constraints;
  }

  return detail;
}

/** Rebuilds the service list, dropping anything the product does not define. */
export function normaliseServices(value: unknown): ComposeServiceDetail[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    )
    .map((entry) => ({
      name: text(entry.name) ?? 'unknown',
      containerIds: strings(entry.containerIds),
      running: number(entry.running) ?? 0,
      total: number(entry.total) ?? 0,
      state: text(entry.state) ?? 'unknown',
    }))
    .filter((service) => service.name !== '');
}

/**
 * The Compose labels the product groups by.
 *
 * An allow list rather than a filter: labels are free-form and routinely carry
 * deployment detail, so anything not named here stays on the host.
 */
const FORWARDED_LABELS = new Set([
  'com.docker.compose.project',
  'com.docker.compose.service',
  'com.docker.compose.container-number',
  'com.docker.compose.oneoff',
]);

function composeLabels(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }

  const labels: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORWARDED_LABELS.has(key) && typeof entry === 'string') {
      labels[key] = entry.slice(0, 256);
    }
  }

  return labels;
}

function ports(value: unknown): ContainerDetail['ports'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    )
    .map((entry) => {
      const port: ContainerDetail['ports'][number] = {
        containerPort: number(entry.containerPort) ?? 0,
        protocol: text(entry.protocol) ?? 'tcp',
      };

      assign(port, 'hostPort', text(entry.hostPort));
      assign(port, 'hostIp', text(entry.hostIp));

      return port;
    });
}

/**
 * Mounts, without the source path of a bind mount.
 *
 * That a bind mount exists is operational information; where it points is the
 * host's filesystem layout, and a read-only view has no use for it.
 */
function mounts(value: unknown): ContainerDetail['mounts'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    )
    .map((entry) => {
      const mount: ContainerDetail['mounts'][number] = {
        type: text(entry.type) ?? 'unknown',
        readOnly: entry.readOnly === true,
      };

      if (mount.type === 'volume') {
        assign(mount, 'name', text(entry.name));
      }

      return mount;
    });
}

function limits(value: unknown): ContainerDetail['limits'] | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const constraints: NonNullable<ContainerDetail['limits']> = {};

  assign(constraints, 'memoryBytes', number(raw.memoryBytes));
  assign(constraints, 'nanoCpus', number(raw.nanoCpus));
  assign(constraints, 'pidsLimit', number(raw.pidsLimit));

  return Object.keys(constraints).length > 0 ? constraints : undefined;
}

function assign<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, 1024) : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.slice(0, 256))
    : [];
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
