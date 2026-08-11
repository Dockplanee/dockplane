import { Injectable } from '@nestjs/common';
import { SQL, and, count, desc, eq, ilike, or } from 'drizzle-orm';

import { AgentConnectionManager } from '../agents/connection-manager.service';
import { Database } from '../database/database';
import { agents, composeProjects, containers, hosts } from '../database/schema';

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
@Injectable()
export class InventoryService {
  constructor(
    private readonly db: Database,
    private readonly connections: AgentConnectionManager,
  ) {}

  async listHosts(page: Page) {
    const rows = await this.db.client
      .select({ host: hosts, agent: agents })
      .from(hosts)
      .leftJoin(agents, eq(agents.hostId, hosts.id))
      .orderBy(hosts.hostname)
      .limit(page.limit)
      .offset(page.offset);

    const [{ value: total }] = await this.db.client.select({ value: count() }).from(hosts);

    return { hosts: rows.map((row) => this.presentHost(row.host, row.agent)), total };
  }

  async findHost(id: string) {
    const [row] = await this.db.client
      .select({ host: hosts, agent: agents })
      .from(hosts)
      .leftJoin(agents, eq(agents.hostId, hosts.id))
      .where(eq(hosts.id, id));

    return row ? this.presentHost(row.host, row.agent) : undefined;
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

    return {
      containers: rows.map((row) => this.presentContainer(row.container, row.host, row.project)),
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

    return row ? this.presentContainer(row.container, row.host, row.project) : undefined;
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

    return { projects: rows.map((row) => this.presentProject(row.project, row.host)), total };
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

    return {
      ...this.presentProject(row.project, row.host),
      containers: members.map((container) => ({
        id: container.id,
        dockerId: container.dockerId,
        name: container.name,
        state: container.state,
        health: container.health,
        ...this.freshness(container.observedAt),
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
  ) {
    return {
      id: container.id,
      hostId: container.hostId,
      hostname: host.hostname,
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
      ...this.freshness(container.observedAt),
    };
  }

  private presentProject(
    project: typeof composeProjects.$inferSelect,
    host: typeof hosts.$inferSelect,
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
      ...this.freshness(project.observedAt),
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
