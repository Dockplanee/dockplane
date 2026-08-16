import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import { AgentConnectionManager } from '../agents/connection-manager.service';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/authenticated-request';
import { AppError } from '../common/errors';
import { Database } from '../database/database';
import { agents, hosts } from '../database/schema';

export interface ArchiveContext {
  readonly sourceIp?: string;
  readonly userAgent?: string;
}

/**
 * Taking a host out of the working set, and putting it back.
 *
 * Archiving is a lifecycle decision, not a deletion and not a security action.
 * Nothing is removed: the host record, its agents, its containers, its Compose
 * projects, its stacks and every action and audit entry that names it are
 * untouched, and every historical view goes on resolving the identity. What
 * changes is that the host stops being offered as somewhere to do new work.
 *
 * It is also not a merge. Two enrolments of one machine remain two hosts;
 * archiving one of them is how an operator says which is current, and it makes
 * no claim that the two are the same thing.
 */
@Injectable()
export class HostArchiveService {
  constructor(
    private readonly db: Database,
    private readonly connections: AgentConnectionManager,
    private readonly audit: AuditService,
  ) {}

  /**
   * Whether a host has an agent connected right now.
   *
   * Asked of the connection registry at the moment of the mutation. A host that
   * looked idle when the page was rendered may have reconnected since, and the
   * decision has to be made against the connection that exists now rather than
   * against the state a browser last saw.
   */
  private async isConnected(hostId: string): Promise<boolean> {
    const rows = await this.db.client
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.hostId, hostId), isNull(agents.revokedAt)));

    return rows.some((agent) => this.connections.isConnected(agent.id));
  }

  private async load(hostId: string) {
    const [host] = await this.db.client.select().from(hosts).where(eq(hosts.id, hostId));

    if (!host) {
      throw AppError.notFound('HOST_NOT_FOUND', 'The host does not exist.');
    }

    return host;
  }

  /**
   * Archives a host that is not currently in use.
   *
   * Refused while an agent is connected. Archiving is for identities that are
   * finished — a machine that was replaced, an enrolment that was superseded —
   * and hiding a host whose agent is answering would take a working machine out
   * of the lists that manage it.
   *
   * Archiving an already-archived host changes nothing and is not an error, so
   * a repeated request cannot produce a second audit entry for a decision that
   * was taken once.
   */
  async archive(hostId: string, user: AuthenticatedUser, context: ArchiveContext = {}) {
    const host = await this.load(hostId);

    if (host.archivedAt) {
      return host;
    }

    if (await this.isConnected(hostId)) {
      throw AppError.conflict(
        'HOST_CONNECTED',
        'The host has a connected agent, so it is in use and cannot be archived.',
      );
    }

    const archivedAt = new Date();

    /*
     * Conditional on the host still being active. Two requests that pass the
     * check together must not both write, and the second one finding no row is
     * how this stays a single decision.
     */
    const [updated] = await this.db.client
      .update(hosts)
      .set({ archivedAt, updatedAt: archivedAt })
      .where(and(eq(hosts.id, hostId), isNull(hosts.archivedAt)))
      .returning();

    if (!updated) {
      return this.load(hostId);
    }

    await this.record('host.archived', updated, user, context);

    return updated;
  }

  /**
   * Returns a host to the working set.
   *
   * Visibility and nothing else: no reconnection is attempted, no agent is
   * re-enrolled, no workload is started. Whether the machine answers again is
   * up to the machine.
   */
  async unarchive(hostId: string, user: AuthenticatedUser, context: ArchiveContext = {}) {
    const host = await this.load(hostId);

    if (!host.archivedAt) {
      return host;
    }

    const [updated] = await this.db.client
      .update(hosts)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(hosts.id, hostId))
      .returning();

    await this.record('host.unarchived', updated, user, context);

    return updated;
  }

  /**
   * The trail names the host by its identifier.
   *
   * A hostname is shared by every enrolment of one machine, so an entry that
   * identified a host by name would not say which of them was archived.
   */
  private async record(
    action: 'host.archived' | 'host.unarchived',
    host: typeof hosts.$inferSelect,
    user: AuthenticatedUser,
    context: ArchiveContext,
  ): Promise<void> {
    await this.audit.record({
      actorUserId: user.id,
      actorLabel: user.email,
      action,
      targetType: 'host',
      targetId: host.id,
      targetLabel: host.displayName ?? host.hostname,
      result: 'success',
      sourceIp: context.sourceIp,
      userAgent: context.userAgent,
    });
  }
}
