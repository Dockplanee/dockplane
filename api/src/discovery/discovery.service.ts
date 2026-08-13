import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { Logger } from 'pino';

import { AgentDispatchService } from '../agents/agent-dispatch.service';
import { LOGGER } from '../config/tokens';
import { Database } from '../database/database';
import { agents, composeProjects, containers, events, hosts } from '../database/schema';
import { EventType, EventsService } from '../events/events.service';

/**
 * The label a container Dockplane built carries.
 *
 * Identity, not authorisation. A container is not mutable because somebody set
 * this on it: every mutation is authorised, resolved and dispatched by the
 * control server long before a label is read. What this decides is which
 * resource an observed container belongs to.
 */
const DOCKPLANE_CONTAINER_ID = 'io.dockplane.container-id';

/** Whether the container claims Dockplane built it. */
const DOCKPLANE_MANAGED = 'io.dockplane.managed';

/**
 * Which configuration the container is running.
 *
 * Separate from the resource identity because they answer different questions:
 * one says which container this is, the other says which of that container's
 * configurations was applied. An interrupted replacement needs the second, and
 * nothing else can supply it — the two configurations may differ in nothing
 * this projection carries.
 */
const DOCKPLANE_DESIRED_CONFIG_ID = 'io.dockplane.desired-config-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shapes the agent reports. Only fields the product stores are read. */
interface HostInventory {
  hostname?: string;
  os?: string;
  osVersion?: string;
  architecture?: string;
  kernel?: string;
  uptimeSeconds?: number;
  cpuCount?: number;
  cpuModel?: string;
  memoryTotalBytes?: number;
  dockerVersion?: string;
  agentVersion?: string;
  observedAt?: string;
}

interface ContainerSummary {
  dockerId: string;
  name: string;
  image: string;
  imageId?: string;
  state: string;
  status: string;
  health: string;
  createdAt?: string;
  labels?: Record<string, string>;
}

interface ComposeService {
  name: string;
  containerIds: string[];
  running: number;
  total: number;
  state: string;
}

interface ComposeProject {
  projectName: string;
  status: string;
  serviceCount: number;
  runningCount: number;
  services?: ComposeService[];
}

/** What a completed sync changed, used for logging and tests. */
export interface SyncResult {
  readonly snapshotId: string;
  /** The host that was read, so a caller need not resolve the agent again. */
  readonly hostId: string;
  readonly complete: boolean;
  readonly containers: number;
  readonly projects: number;
  readonly removed: number;
}

/**
 * Discovery.
 *
 * The server asks; the agent answers. Nothing an agent sends is written without
 * being attributed to the host behind its authenticated identity, so a reply
 * cannot describe a machine other than the one that produced it.
 *
 * Reconciliation is snapshot-based. A partial sync updates what it saw and
 * removes nothing: absence only means "gone" when a complete snapshot says so.
 */
@Injectable()
export class DiscoveryService {
  constructor(
    private readonly db: Database,
    private readonly dispatch: AgentDispatchService,
    private readonly events: EventsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Runs a full discovery pass for one agent.
   *
   * Each step is attempted independently. A host whose Docker daemon is down
   * still yields inventory and metrics, which is exactly when an operator most
   * needs to see the host.
   */
  async sync(agentId: string): Promise<SyncResult> {
    const [agent] = await this.db.client.select().from(agents).where(eq(agents.id, agentId));

    if (!agent) {
      throw new Error(`no such agent: ${agentId}`);
    }

    const snapshotId = randomUUID();
    const startedAt = new Date();

    let complete = true;
    let containerCount = 0;
    let projectCount = 0;

    try {
      const inventory = await this.dispatch.request<HostInventory>(agentId, 'host.inventory');
      await this.applyInventory(agent.hostId, inventory, agent.version ?? undefined);
    } catch (error) {
      complete = false;
      await this.recordFailure(agent.hostId, 'host.inventory', error);
    }

    try {
      const metrics = await this.dispatch.request<Record<string, unknown>>(agentId, 'host.metrics');
      await this.applyMetrics(agent.hostId, metrics);
    } catch (error) {
      complete = false;
      await this.recordFailure(agent.hostId, 'host.metrics', error);
    }

    try {
      const result = await this.dispatch.request<{ containers: ContainerSummary[] }>(
        agentId,
        'container.list',
      );

      containerCount = await this.applyContainers(
        agent.hostId,
        result?.containers ?? [],
        snapshotId,
      );
    } catch (error) {
      complete = false;
      await this.recordFailure(agent.hostId, 'container.list', error);
    }

    try {
      const result = await this.dispatch.request<{ projects: ComposeProject[] }>(
        agentId,
        'compose.list',
      );

      projectCount = await this.applyProjects(agent.hostId, result?.projects ?? [], snapshotId);
    } catch (error) {
      complete = false;
      await this.recordFailure(agent.hostId, 'compose.list', error);
    }

    const removed = complete ? await this.reconcile(agent.hostId, snapshotId) : 0;

    this.logger.info(
      {
        event: 'discovery_completed',
        agentId,
        hostId: agent.hostId,
        snapshotId,
        complete,
        containers: containerCount,
        projects: projectCount,
        removed,
        durationMs: Date.now() - startedAt.getTime(),
      },
      complete ? 'discovery completed' : 'discovery completed with gaps',
    );

    return {
      snapshotId,
      hostId: agent.hostId,
      complete,
      containers: containerCount,
      projects: projectCount,
      removed,
    };
  }

  private async applyInventory(
    hostId: string,
    inventory: HostInventory,
    agentVersion?: string,
  ): Promise<void> {
    const observedAt = parseDate(inventory?.observedAt) ?? new Date();

    const [previous] = await this.db.client.select().from(hosts).where(eq(hosts.id, hostId));

    await this.db.client
      .update(hosts)
      .set({
        hostname: inventory?.hostname || previous?.hostname || 'unidentified-host',
        os: joinOs(inventory?.os, inventory?.osVersion) ?? previous?.os ?? null,
        architecture: inventory?.architecture ?? previous?.architecture ?? null,
        kernel: inventory?.kernel ?? previous?.kernel ?? null,
        dockerVersion: inventory?.dockerVersion || previous?.dockerVersion || null,
        agentVersion: inventory?.agentVersion ?? agentVersion ?? previous?.agentVersion ?? null,
        metadata: {
          cpuCount: inventory?.cpuCount,
          cpuModel: inventory?.cpuModel,
          memoryTotalBytes: inventory?.memoryTotalBytes,
          uptimeSeconds: inventory?.uptimeSeconds,
        },
        observedAt,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(hosts.id, hostId));

    if (changedInventory(previous, inventory)) {
      await this.emit(
        hostId,
        'host.inventory.updated',
        'info',
        `host:${hostId}`,
        'Host inventory changed.',
      );
    }
  }

  private async applyMetrics(hostId: string, metrics: Record<string, unknown>): Promise<void> {
    await this.db.client
      .update(hosts)
      .set({ metrics, lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(hosts.id, hostId));
  }

  private async applyContainers(
    hostId: string,
    reported: ContainerSummary[],
    snapshotId: string,
  ): Promise<number> {
    const observedAt = new Date();

    const existing = await this.db.client
      .select()
      .from(containers)
      .where(eq(containers.hostId, hostId));

    const byDockerId = new Map(
      existing.filter((row) => row.dockerId !== null).map((row) => [row.dockerId, row]),
    );

    /*
     * Containers Dockplane built carry the identity it gave them.
     *
     * Docker gives a replacement a new identifier, so matching on that alone
     * would see one container vanish and another appear — the operator's
     * resource would be deleted and recreated under a new address, taking its
     * URL and its history with it. The label is what says the replacement is
     * the same thing.
     */
    const byIdentity = new Map(existing.map((row) => [row.id, row]));
    const claimed = new Map<string, string[]>();

    for (const item of reported) {
      const identity = item?.labels?.[DOCKPLANE_CONTAINER_ID];

      if (identity && item?.dockerId) {
        claimed.set(identity, [...(claimed.get(identity) ?? []), item.dockerId]);
      }
    }

    for (const item of reported) {
      if (!item?.dockerId) {
        continue;
      }

      const identity = item.labels?.[DOCKPLANE_CONTAINER_ID];

      /*
       * Two containers claiming one identity, and nothing running to explain
       * it. A replacement in progress legitimately has both for a moment, and
       * the mutation holding the resource is authoritative until it finishes.
       */
      if (identity && (claimed.get(identity)?.length ?? 0) > 1 && !this.mutating(identity)) {
        await this.recordIdentityConflict(identity, claimed.get(identity) ?? [], hostId);
        await this.keep(identity, snapshotId, observedAt);
        continue;
      }

      // A resource being replaced is the mutation's to move, not discovery's.
      if (identity && this.mutating(identity)) {
        await this.keep(identity, snapshotId, observedAt);
        continue;
      }

      const previous =
        (identity ? byIdentity.get(identity) : undefined) ?? byDockerId.get(item.dockerId);
      const projectName = item.labels?.['com.docker.compose.project'];

      const values = {
        hostId,
        dockerId: item.dockerId,
        observedDesiredConfigId: this.observedConfig(item, hostId),
        name: item.name ?? '',
        image: item.image ?? '',
        imageId: item.imageId ?? null,
        state: item.state ?? 'unknown',
        health: item.health ?? 'none',
        composeProjectId: projectName
          ? await this.projectId(hostId, projectName, snapshotId, observedAt)
          : null,
        dockerCreatedAt: parseDate(item.createdAt),
        metadata: { service: item.labels?.['com.docker.compose.service'], status: item.status },
        snapshotId,
        observedAt,
        updatedAt: new Date(),
      };

      if (previous) {
        await this.db.client.update(containers).set(values).where(eq(containers.id, previous.id));

        if (previous.state !== values.state) {
          await this.emit(
            hostId,
            'container.state.changed',
            values.state === 'running' ? 'info' : 'warning',
            `container:${item.dockerId}`,
            `${values.name} is ${values.state}.`,
          );
        }

        if (previous.health !== values.health) {
          await this.emit(
            hostId,
            'container.health.changed',
            values.health === 'unhealthy' ? 'critical' : 'info',
            `container:${item.dockerId}`,
            `${values.name} reports health ${values.health}.`,
          );
        }
      } else {
        await this.db.client.insert(containers).values(values);

        await this.emit(
          hostId,
          'container.discovered',
          'info',
          `container:${item.dockerId}`,
          `${values.name} was discovered.`,
        );
      }
    }

    return reported.length;
  }

  /**
   * Reads the configuration a container claims to be running.
   *
   * Strict about the shape, and deliberately unforgiving in one direction: a
   * container that says Dockplane built it and then offers something that is
   * not an identifier is recorded as having none. Storing the malformed value
   * would put a host-written string where the control server expects one of its
   * own; ignoring it quietly would leave the container looking like an ordinary
   * unmanaged one. Recording nothing is what makes recovery refuse to interpret
   * it, which is the outcome that state deserves.
   *
   * A container without the managed label is not Dockplane's and is not asked
   * this question at all.
   */
  private observedConfig(item: ContainerSummary, hostId: string): string | null {
    if (item.labels?.[DOCKPLANE_MANAGED] !== 'true') {
      return null;
    }

    const claimed = item.labels?.[DOCKPLANE_DESIRED_CONFIG_ID];

    if (!claimed) {
      return null;
    }

    if (!UUID.test(claimed)) {
      this.logger.warn(
        {
          event: 'container_configuration_identity_unreadable',
          hostId,
          dockerId: item.dockerId,
        },
        'a managed container carries an unreadable configuration identity',
      );

      return null;
    }

    return claimed;
  }

  /*
   * Whether a mutation currently owns a resource.
   *
   * Set by the container mutation service while a replacement is in flight.
   * Discovery does not move a resource that something else is deliberately
   * moving.
   */
  private mutating(containerId: string): boolean {
    return this.inFlightResources?.has(containerId) ?? false;
  }

  /** Registered by the mutation service so both agree on what is in flight. */
  registerInFlight(resources: ReadonlySet<string>): void {
    this.inFlightResources = resources;
  }

  private inFlightResources?: ReadonlySet<string>;

  /*
   * Marks a resource as still seen, without moving it.
   *
   * The sweep at the end of a pass removes anything the pass did not touch, and
   * its whole point is that a running container never vanishes from the
   * interface. A resource that was deliberately left alone — because a
   * replacement owns it, or because two containers claim it — has still been
   * seen, and must not be deleted for having been skipped.
   */
  private async keep(containerId: string, snapshotId: string, observedAt: Date): Promise<void> {
    await this.db.client
      .update(containers)
      .set({ snapshotId, observedAt })
      .where(eq(containers.id, containerId));
  }

  private async recordIdentityConflict(
    containerId: string,
    dockerIds: readonly string[],
    hostId: string,
  ): Promise<void> {
    await this.db.client
      .update(containers)
      .set({
        identityConflict: { dockerIds: [...dockerIds], observedAt: new Date().toISOString() },
      })
      .where(eq(containers.id, containerId));

    this.logger.warn(
      {
        event: 'container_identity_conflict',
        containerId,
        hostId,
        dockerIds,
      },
      'two containers claim one Dockplane identity',
    );
  }

  private async applyProjects(
    hostId: string,
    reported: ComposeProject[],
    snapshotId: string,
  ): Promise<number> {
    const observedAt = new Date();

    for (const project of reported) {
      if (!project?.projectName) {
        continue;
      }

      const [previous] = await this.db.client
        .select()
        .from(composeProjects)
        .where(
          and(
            eq(composeProjects.hostId, hostId),
            eq(composeProjects.projectName, project.projectName),
          ),
        );

      const values = {
        hostId,
        projectName: project.projectName,
        status: project.status ?? 'unknown',
        serviceCount: project.serviceCount ?? 0,
        runningCount: project.runningCount ?? 0,
        services: project.services ?? [],
        snapshotId,
        observedAt,
        updatedAt: new Date(),
      };

      if (previous) {
        await this.db.client
          .update(composeProjects)
          .set(values)
          .where(eq(composeProjects.id, previous.id));

        if (previous.status !== values.status) {
          await this.emit(
            hostId,
            'compose.state.changed',
            values.status === 'running' ? 'info' : 'warning',
            `compose:${project.projectName}`,
            `${project.projectName} is ${values.status}.`,
          );
        }
      } else {
        await this.db.client.insert(composeProjects).values(values);

        await this.emit(
          hostId,
          'compose.discovered',
          'info',
          `compose:${project.projectName}`,
          `${project.projectName} was discovered.`,
        );
      }
    }

    return reported.length;
  }

  /** Ensures a project row exists so a container can reference it. */
  private async projectId(
    hostId: string,
    projectName: string,
    snapshotId: string,
    observedAt: Date,
  ): Promise<string> {
    const [existing] = await this.db.client
      .select({ id: composeProjects.id })
      .from(composeProjects)
      .where(and(eq(composeProjects.hostId, hostId), eq(composeProjects.projectName, projectName)));

    if (existing) {
      return existing.id;
    }

    const [created] = await this.db.client
      .insert(composeProjects)
      .values({ hostId, projectName, snapshotId, observedAt })
      .returning({ id: composeProjects.id });

    return created.id;
  }

  /**
   * Removes what a complete snapshot did not see.
   *
   * Only reached when every step of the pass succeeded. That condition is the
   * whole point: a container that is still running must never disappear from
   * the interface because one request timed out.
   *
   * A resource whose create has not produced a container yet is not swept: it
   * has no Docker container to be absent, so a snapshot that does not mention
   * it says nothing about it. Whether that create happened is recovery's
   * question, and deleting the row here would take the evidence with it.
   */
  private async reconcile(hostId: string, snapshotId: string): Promise<number> {
    return this.db.client.transaction(async (tx) => {
      const staleContainers = await tx
        .delete(containers)
        .where(
          and(
            eq(containers.hostId, hostId),
            isNotNull(containers.dockerId),
            ne(containers.snapshotId, snapshotId),
          ),
        )
        .returning({ dockerId: containers.dockerId, name: containers.name });

      const staleProjects = await tx
        .delete(composeProjects)
        .where(and(eq(composeProjects.hostId, hostId), ne(composeProjects.snapshotId, snapshotId)))
        .returning({ projectName: composeProjects.projectName });

      for (const container of staleContainers) {
        await tx.insert(events).values({
          hostId,
          type: 'container.removed',
          severity: 'info',
          resource: `container:${container.dockerId}`,
          message: `${container.name} is no longer present.`,
        });
      }

      for (const project of staleProjects) {
        await tx.insert(events).values({
          hostId,
          type: 'compose.removed',
          severity: 'info',
          resource: `compose:${project.projectName}`,
          message: `${project.projectName} is no longer present.`,
        });
      }

      return staleContainers.length + staleProjects.length;
    });
  }

  private async recordFailure(hostId: string, capability: string, error: unknown): Promise<void> {
    const code = error instanceof Error ? error.message : 'unknown';

    this.logger.warn(
      { event: 'discovery_step_failed', hostId, capability, reason: code },
      'a discovery step failed',
    );

    await this.emit(
      hostId,
      'inventory.sync.failed',
      'warning',
      `capability:${capability}`,
      `${capability} did not complete.`,
    );
  }

  /**
   * Records an operational event.
   *
   * Only changes are recorded. Emitting on every poll would bury the one event
   * that mattered under thousands that said nothing.
   */
  private async emit(
    hostId: string,
    type: EventType,
    severity: 'info' | 'warning' | 'critical',
    resource: string,
    message: string,
  ): Promise<void> {
    await this.events.record({ hostId, type, severity, resource, message });
  }
}

function parseDate(value?: string): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function joinOs(os?: string, version?: string): string | null {
  if (!os) {
    return null;
  }

  return version ? `${os} ${version}` : os;
}

/** Inventory changes rarely; comparing avoids an event on every pass. */
function changedInventory(
  previous: { os: string | null; kernel: string | null; dockerVersion: string | null } | undefined,
  inventory: HostInventory,
): boolean {
  if (!previous) {
    return true;
  }

  return (
    previous.os !== joinOs(inventory?.os, inventory?.osVersion) ||
    previous.kernel !== (inventory?.kernel ?? null) ||
    previous.dockerVersion !== (inventory?.dockerVersion ?? null)
  );
}
