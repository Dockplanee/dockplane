import { Injectable } from '@nestjs/common';
import { SQL, and, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { AgentConnectionManager } from '../agents/connection-manager.service';
import { Database } from '../database/database';
import {
  actions,
  agents,
  composeProjects,
  containerDesiredConfigs,
  containers,
  hosts,
} from '../database/schema';

/** The operations that leave a container unresolved until they are settled. */
const MANAGEMENT_CAPABILITIES = ['container.create', 'container.replace', 'container.remove'];

/**
 * Who decides what a container is.
 *
 * The distinction the interface needs before it offers anything: a container
 * Dockplane built can be changed, one it merely found cannot be changed without
 * inventing a configuration for somebody else's workload, and one belonging to
 * a Compose project gets its configuration from there.
 */
export type ManagementKind = 'managed' | 'external' | 'stack';

/** What may be done to a container, beyond what a permission allows. */
export interface ManagementState {
  readonly kind: ManagementKind;
  /**
   * An operation that has not been settled yet.
   *
   * Either a candidate configuration nobody has confirmed or an action that was
   * dispatched and never resolved. Both mean the same thing to an operator: the
   * container cannot be changed until Dockplane has read its host again.
   */
  readonly reconciling: boolean;
  /** Two Docker containers claim this one, so nothing may be done to it. */
  readonly identityConflict: boolean;
}

/**
 * How long after its last observation a record is presented as stale.
 *
 * Three discovery intervals: long enough that one missed pass is not alarming,
 * short enough that an operator is not shown minutes-old state as current.
 */
const STALE_AFTER_MS = 180_000;

export interface Page {
  readonly limit: number;
  readonly offset: number;
}

/** Presentation state shared by everything discovery writes. */
interface Freshness {
  readonly observedAt: Date | null;
  readonly stale: boolean;
}

/**
 * The read model over discovered infrastructure.
 *
 * Every record carries when it was observed and whether that observation is
 * still current. A disconnected host keeps its inventory — deleting it would
 * lose the last known state exactly when an operator needs it — but nothing it
 * reported is presented as live.
 */
/**
 * Which hosts a list is about.
 *
 * `active` is the working set and the default everywhere. The other two exist
 * so an operator can find what was archived and put it back; nothing is hidden
 * permanently.
 */
export type HostScope = 'active' | 'archived' | 'all';

@Injectable()
export class InventoryService {
  constructor(
    private readonly db: Database,
    private readonly connections: AgentConnectionManager,
  ) {}

  /*
   * The working list, which is the active hosts unless somebody asks otherwise.
   *
   * Only this list and the selectors built on it filter. Every historical
   * relation — a container, a project, a stack, an action — resolves its host
   * without consulting the archive state, because the record of what a machine
   * ran does not stop being true when the machine leaves the working set.
   */
  async listHosts(page: Page, scope: HostScope = 'active') {
    const filter =
      scope === 'active'
        ? isNull(hosts.archivedAt)
        : scope === 'archived'
          ? isNotNull(hosts.archivedAt)
          : undefined;

    const rows = await this.db.client
      .select()
      .from(hosts)
      .where(filter)
      .orderBy(hosts.hostname)
      .limit(page.limit)
      .offset(page.offset);

    const [{ value: total }] = await this.db.client
      .select({ value: count() })
      .from(hosts)
      .where(filter);
    const byHost = await this.agentsOf(rows.map((host) => host.id));

    return {
      hosts: rows.map((host) => this.presentHost(host, byHost.get(host.id) ?? null)),
      total,
    };
  }

  async findHost(id: string) {
    const [host] = await this.db.client.select().from(hosts).where(eq(hosts.id, id));

    if (!host) {
      return undefined;
    }

    const byHost = await this.agentsOf([host.id]);

    return this.presentHost(host, byHost.get(host.id) ?? null);
  }

  /**
   * The agent that speaks for each host, one per host.
   *
   * Deliberately not a join. Nothing in the schema stops a host from having
   * more than one agent row, and a join would then return that host once per
   * agent — a list that repeats a host, and a total, taken from the hosts
   * table, that disagrees with the rows beside it. Whether that can happen
   * today is not the point: a read model should not depend on it.
   *
   * Which one speaks, when there is more than one: the agent that has not been
   * revoked, most recently enrolled. Revocation is what ends an agent's claim
   * to a host, so a revoked one is only shown when it is all there is.
   */
  private async agentsOf(hostIds: readonly string[]) {
    const byHost = new Map<string, typeof agents.$inferSelect>();

    if (hostIds.length === 0) {
      return byHost;
    }

    const rows = await this.db.client
      .select()
      .from(agents)
      .where(inArray(agents.hostId, [...hostIds]))
      // Postgres sorts nulls last by default, and a null here is the agent that
      // has not been revoked — the one that should come first.
      .orderBy(sql`${agents.revokedAt} asc nulls first`, desc(agents.enrolledAt));

    for (const agent of rows) {
      if (!byHost.has(agent.hostId)) {
        byHost.set(agent.hostId, agent);
      }
    }

    return byHost;
  }

  /**
   * Which of these hosts have something listening, as far as this process knows.
   *
   * Undefined for a host with no agent at all: not connected and never going to
   * be are different claims, and only the second is knowable here.
   */
  private async connectionsByHost(
    hostIds: readonly string[],
  ): Promise<Map<string, boolean | undefined>> {
    const agentByHost = await this.agentsOf(hostIds);
    const connected = new Map<string, boolean | undefined>();

    for (const hostId of hostIds) {
      const agent = agentByHost.get(hostId);

      connected.set(hostId, agent ? this.connections.isConnected(agent.id) : undefined);
    }

    return connected;
  }

  async listContainers(
    page: Page,
    filters: { hostId?: string; state?: string; project?: string; search?: string },
  ) {
    const conditions: SQL[] = [];

    if (filters.hostId) {
      conditions.push(eq(containers.hostId, filters.hostId));
    }

    if (filters.state) {
      conditions.push(eq(containers.state, filters.state));
    }

    if (filters.project) {
      conditions.push(eq(composeProjects.projectName, filters.project));
    }

    if (filters.search) {
      const pattern = `%${filters.search}%`;
      const match = or(ilike(containers.name, pattern), ilike(containers.image, pattern));

      if (match) {
        conditions.push(match);
      }
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await this.db.client
      .select({ container: containers, host: hosts, project: composeProjects })
      .from(containers)
      .innerJoin(hosts, eq(hosts.id, containers.hostId))
      .leftJoin(composeProjects, eq(composeProjects.id, containers.composeProjectId))
      .where(where)
      .orderBy(hosts.hostname, containers.name)
      .limit(page.limit)
      .offset(page.offset);

    const [{ value: total }] = await this.db.client
      .select({ value: count() })
      .from(containers)
      .innerJoin(hosts, eq(hosts.id, containers.hostId))
      .leftJoin(composeProjects, eq(composeProjects.id, containers.composeProjectId))
      .where(where);

    const management = await this.managementFor(rows);
    const connected = await this.connectionsByHost([
      ...new Set(rows.map((row) => row.container.hostId)),
    ]);

    return {
      containers: rows.map((row) =>
        this.presentContainer(
          row.container,
          row.host,
          row.project,
          management.get(row.container.id)!,
          connected.get(row.container.hostId),
        ),
      ),
      total,
    };
  }

  async findContainer(id: string) {
    const [row] = await this.db.client
      .select({ container: containers, host: hosts, project: composeProjects })
      .from(containers)
      .innerJoin(hosts, eq(hosts.id, containers.hostId))
      .leftJoin(composeProjects, eq(composeProjects.id, containers.composeProjectId))
      .where(eq(containers.id, id));

    if (!row) {
      return undefined;
    }

    const management = await this.managementFor([row]);
    const connected = await this.connectionsByHost([row.container.hostId]);

    return this.presentContainer(
      row.container,
      row.host,
      row.project,
      management.get(row.container.id)!,
      connected.get(row.container.hostId),
    );
  }

  async listProjects(page: Page, filters: { hostId?: string }) {
    const where = filters.hostId ? eq(composeProjects.hostId, filters.hostId) : undefined;

    const rows = await this.db.client
      .select({ project: composeProjects, host: hosts })
      .from(composeProjects)
      .innerJoin(hosts, eq(hosts.id, composeProjects.hostId))
      .where(where)
      .orderBy(hosts.hostname, composeProjects.projectName)
      .limit(page.limit)
      .offset(page.offset);

    const [{ value: total }] = await this.db.client
      .select({ value: count() })
      .from(composeProjects)
      .where(where);

    const connected = await this.connectionsByHost([
      ...new Set(rows.map((row) => row.project.hostId)),
    ]);

    return {
      projects: rows.map((row) =>
        this.presentProject(row.project, row.host, connected.get(row.project.hostId)),
      ),
      total,
    };
  }

  async findProject(id: string) {
    const [row] = await this.db.client
      .select({ project: composeProjects, host: hosts })
      .from(composeProjects)
      .innerJoin(hosts, eq(hosts.id, composeProjects.hostId))
      .where(eq(composeProjects.id, id));

    if (!row) {
      return undefined;
    }

    const members = await this.db.client
      .select()
      .from(containers)
      .where(eq(containers.composeProjectId, row.project.id))
      .orderBy(desc(containers.name));

    /*
     * One lookup for the whole page: a project's containers are on the project's
     * host by definition, so the connection that decides the project's freshness
     * decides theirs. Judging them separately is how a project came to be shown
     * as running while the host it is on said it was offline.
     */
    const connected = (await this.connectionsByHost([row.project.hostId])).get(row.project.hostId);

    return {
      ...this.presentProject(row.project, row.host, connected),
      containers: members.map((container) => ({
        id: container.id,
        dockerId: container.dockerId,
        name: container.name,
        state: container.state,
        health: container.health,
        ...this.freshness(container.observedAt, connected),
      })),
    };
  }

  private presentHost(host: typeof hosts.$inferSelect, agent: typeof agents.$inferSelect | null) {
    const connected = agent ? this.connections.isConnected(agent.id) : undefined;
    const freshness = this.freshness(host.observedAt, connected);

    return {
      id: host.id,
      hostname: host.hostname,
      displayName: host.displayName,
      os: host.os,
      architecture: host.architecture,
      kernel: host.kernel,
      dockerVersion: host.dockerVersion,
      agentVersion: host.agentVersion,
      metadata: host.metadata,
      /*
       * Metrics are a snapshot, and a snapshot from a host that is no longer
       * reporting is history. It is returned with the moment it was taken and
       * the stale flag, never as a current reading.
       */
      metrics: host.metrics,
      lastSeenAt: host.lastSeenAt,
      /*
       * Persisted state, not a conclusion drawn from the agent or the clock. A
       * host that is offline, or whose agent was revoked, is not archived.
       */
      archivedAt: host.archivedAt,
      archived: host.archivedAt !== null,
      agent: agent
        ? {
            id: agent.id,
            status: agent.revokedAt ? 'revoked' : connected ? 'connected' : 'disconnected',
            connected,
            lastSeenAt: agent.lastSeenAt,
            certificateNotAfter: agent.certificateNotAfter,
          }
        : null,
      ...freshness,
    };
  }

  private presentContainer(
    container: typeof containers.$inferSelect,
    host: typeof hosts.$inferSelect,
    project: typeof composeProjects.$inferSelect | null,
    management: ManagementState,
    agentConnected?: boolean,
  ) {
    return {
      id: container.id,
      hostId: container.hostId,
      hostname: host.hostname,
      /*
       * What the host is called, when somebody named it. The system hostname
       * alone cannot tell two host resources apart: a machine enrolled more
       * than once reports the same one from every identity it has.
       */
      hostDisplayName: host.displayName,
      dockerId: container.dockerId,
      name: container.name,
      image: container.image,
      imageId: container.imageId,
      state: container.state,
      health: container.health,
      restartCount: container.restartCount,
      createdAt: container.dockerCreatedAt,
      composeProject: project ? { id: project.id, name: project.projectName } : null,
      metadata: container.metadata,
      management,
      /*
       * Judged against the host's connection, not only the age of the reading.
       * A container on a host that stopped answering a second ago is no more
       * current than its host is, and showing it as live beside a host that
       * already says it is offline is the contradiction an operator has to
       * resolve at exactly the wrong moment.
       */
      ...this.freshness(container.observedAt, agentConnected),
    };
  }

  /**
   * Works out what may be done to each of a set of containers.
   *
   * Read for the whole page at once rather than per row: the interface asks
   * this of every container it lists, and a query per container would turn one
   * listing into a hundred.
   */
  private async managementFor(
    rows: readonly { container: typeof containers.$inferSelect }[],
  ): Promise<Map<string, ManagementState>> {
    const ids = rows.map((row) => row.container.id);
    const states = new Map<string, ManagementState>();

    if (ids.length === 0) {
      return states;
    }

    const configs = await this.db.client
      .select({
        containerId: containerDesiredConfigs.containerId,
        state: containerDesiredConfigs.state,
      })
      .from(containerDesiredConfigs)
      .where(inArray(containerDesiredConfigs.containerId, ids));

    const unresolved = await this.db.client
      .select({ targetId: actions.targetId })
      .from(actions)
      .where(
        and(
          eq(actions.targetType, 'container'),
          inArray(actions.targetId, ids),
          inArray(actions.status, ['queued', 'running']),
          inArray(actions.capability, MANAGEMENT_CAPABILITIES),
        ),
      );

    const open = new Set(unresolved.map((row) => row.targetId));

    for (const row of rows) {
      const own = configs.filter((config) => config.containerId === row.container.id);

      states.set(row.container.id, {
        kind: row.container.composeProjectId ? 'stack' : own.length > 0 ? 'managed' : 'external',
        reconciling: own.some((config) => config.state === 'pending') || open.has(row.container.id),
        identityConflict: Boolean(row.container.identityConflict),
      });
    }

    return states;
  }

  private presentProject(
    project: typeof composeProjects.$inferSelect,
    host: typeof hosts.$inferSelect,
    agentConnected?: boolean,
  ) {
    return {
      id: project.id,
      hostId: project.hostId,
      hostname: host.hostname,
      projectName: project.projectName,
      status: project.status,
      serviceCount: project.serviceCount,
      runningCount: project.runningCount,
      services: project.services ?? [],
      // As with a host and a container: nothing is going to refresh a project
      // whose host has stopped answering, so its age can only grow.
      ...this.freshness(project.observedAt, agentConnected),
    };
  }

  /**
   * Decides whether an observation still counts as current.
   *
   * An agent that is known to be disconnected makes its host's data stale
   * immediately, however recent the last observation was: nothing is going to
   * refresh it, so the age can only grow. Where no agent is known at all the
   * age is the only honest signal, so the window decides.
   */
  private freshness(observedAt: Date | null, agentConnected?: boolean): Freshness {
    if (!observedAt) {
      return { observedAt: null, stale: true };
    }

    if (agentConnected === false) {
      return { observedAt, stale: true };
    }

    return { observedAt, stale: Date.now() - observedAt.getTime() > STALE_AFTER_MS };
  }
}
