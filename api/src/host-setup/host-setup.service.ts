import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { EnrollmentService } from '../agents/enrollment.service';
import { AuditService } from '../audit/audit.service';
import { generateSecret, hashSecret } from '../common/crypto';
import { AppError } from '../common/errors';
import { AppConfig, CONFIG } from '../config/configuration';
import { Database } from '../database/database';
import { agentEnrollmentTokens, agents, hostSetups, hosts } from '../database/schema';

/**
 * What an operator sees while a host is being added.
 *
 * Derived from what happened rather than announced in advance, so a setup
 * cannot claim a state nothing has demonstrated. There is deliberately no
 * `failed`: nothing reports a failed installation back to the control plane,
 * and a status the server cannot substantiate is worse than none. An
 * installation that goes wrong stays `installing` until the setup expires.
 */
export type HostSetupStatus = 'waiting' | 'installing' | 'connected' | 'expired' | 'cancelled';

/**
 * The steps a waiting operator can be shown.
 *
 * Each one is a fact the control plane observed, not a stage in an animation.
 */
export interface HostSetupProgress {
  /** The command was run and the machine received an enrollment token. */
  readonly bootstrapped: boolean;
  /** The token was exchanged for a certificate. */
  readonly enrolled: boolean;
  /** The agent is on the gateway right now. */
  readonly connected: boolean;
  /** The agent has reported what the host is. */
  readonly inventoryReported: boolean;
}

export interface HostSetupView {
  readonly id: string;
  readonly displayName: string | null;
  readonly status: HostSetupStatus;
  readonly progress: HostSetupProgress;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly agentId: string | null;
  readonly hostId: string | null;
  readonly completedAt: Date | null;
}

export interface CreatedHostSetup extends HostSetupView {
  /** Returned exactly once, on creation and on regeneration. */
  readonly ticket: string;
}

interface Actor {
  readonly id: string;
  readonly email: string;
}

interface RequestContext {
  readonly sourceIp?: string;
  readonly userAgent?: string;
}

/** A setup and everything enrollment has since made of it. */
type SetupRow = typeof hostSetups.$inferSelect;

interface ResolvedSetup {
  readonly setup: SetupRow;
  readonly agentId: string | null;
  readonly agentStatus: string | null;
  readonly hostId: string | null;
  readonly hostReportedOs: string | null;
}

/**
 * Adding a host.
 *
 * Two credentials with different jobs. The bootstrap ticket authorises one
 * machine to ask for an installation, once; the enrollment token that the
 * bootstrap mints is what the agent exchanges for its certificate. Only the
 * first is ever seen by a person, and only its digest is stored.
 *
 * No host or agent row is created here. Those are made by enrollment, exactly
 * as they are for an operator who installs an agent by hand. This service
 * follows the enrollment token it minted to find out what became of it, which
 * is why a setup can never show a host that does not exist.
 */
@Injectable()
export class HostSetupService {
  constructor(
    private readonly db: Database,
    private readonly enrollment: EnrollmentService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async create(
    actor: Actor,
    options: { displayName?: string },
    context: RequestContext,
  ): Promise<CreatedHostSetup> {
    const displayName = normaliseDisplayName(options.displayName);
    const ticket = generateSecret();

    const [created] = await this.db.client
      .insert(hostSetups)
      .values({
        displayName,
        createdBy: actor.id,
        ticketHash: hashSecret(ticket),
        ticketExpiresAt: this.ticketExpiry(),
      })
      .returning();

    await this.audit.record({
      action: 'host.setup.created',
      result: 'success',
      actorUserId: actor.id,
      actorLabel: actor.email,
      targetType: 'host_setup',
      targetId: created.id,
      targetLabel: displayName ?? undefined,
      sourceIp: context.sourceIp,
      userAgent: context.userAgent,
    });

    return { ...view({ setup: created, agentId: null, agentStatus: null, hostId: null, hostReportedOs: null }), ticket };
  }

  /**
   * Issues a new ticket for a setup nobody has used.
   *
   * The digest is replaced rather than added to, so the previous ticket stops
   * working the instant this returns. A setup has one live ticket, always.
   */
  async regenerate(id: string, actor: Actor, context: RequestContext): Promise<CreatedHostSetup> {
    const ticket = generateSecret();
    const now = new Date();

    const [updated] = await this.db.client
      .update(hostSetups)
      .set({
        ticketHash: hashSecret(ticket),
        ticketExpiresAt: this.ticketExpiry(now),
        ticketIssuedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(hostSetups.id, id),
          isNull(hostSetups.ticketConsumedAt),
          isNull(hostSetups.cancelledAt),
        ),
      )
      .returning();

    if (!updated) {
      throw AppError.notFound(
        'HOST_SETUP_NOT_PENDING',
        'This host setup does not exist, or has already been used or cancelled.',
      );
    }

    await this.audit.record({
      action: 'host.setup.regenerated',
      result: 'success',
      actorUserId: actor.id,
      actorLabel: actor.email,
      targetType: 'host_setup',
      targetId: id,
      sourceIp: context.sourceIp,
      userAgent: context.userAgent,
    });

    return { ...view({ setup: updated, agentId: null, agentStatus: null, hostId: null, hostReportedOs: null }), ticket };
  }

  /**
   * Ends a setup.
   *
   * The ticket dies with it. An agent that already enrolled through this setup
   * is untouched: it holds a certificate, and taking that away is a separate,
   * deliberate act with its own permission.
   */
  async cancel(id: string, actor: Actor, context: RequestContext): Promise<HostSetupView> {
    const now = new Date();

    const [cancelled] = await this.db.client
      .update(hostSetups)
      .set({ cancelledAt: now, cancelledBy: actor.id, updatedAt: now })
      .where(and(eq(hostSetups.id, id), isNull(hostSetups.cancelledAt)))
      .returning();

    if (!cancelled) {
      throw AppError.notFound(
        'HOST_SETUP_NOT_FOUND',
        'This host setup does not exist, or was already cancelled.',
      );
    }

    await this.audit.record({
      action: 'host.setup.cancelled',
      result: 'success',
      actorUserId: actor.id,
      actorLabel: actor.email,
      targetType: 'host_setup',
      targetId: id,
      sourceIp: context.sourceIp,
      userAgent: context.userAgent,
    });

    return this.resolveAndSettle(cancelled.id);
  }

  async list(): Promise<HostSetupView[]> {
    const rows = await this.resolve();

    return rows.map((row) => view(row));
  }

  async get(id: string): Promise<HostSetupView> {
    return this.resolveAndSettle(id);
  }

  /**
   * Spends a bootstrap ticket and returns what the installer needs.
   *
   * The claim is a conditional update on the digest rather than a read followed
   * by a write, so two machines racing with the same ticket cannot both be
   * served: the second finds nothing left to claim. The enrollment token is
   * minted only after the claim succeeds, so a losing race mints nothing.
   */
  async consumeTicket(
    ticket: string,
    context: { sourceIp?: string },
  ): Promise<{ setupId: string; displayName: string | null; enrollmentToken: string }> {
    const digest = hashSecret(ticket);
    const now = new Date();

    const claimed = await this.db.client
      .update(hostSetups)
      .set({ ticketConsumedAt: now, updatedAt: now })
      .where(
        and(
          eq(hostSetups.ticketHash, digest),
          isNull(hostSetups.ticketConsumedAt),
          isNull(hostSetups.cancelledAt),
          sql`${hostSetups.ticketExpiresAt} > ${now}`,
        ),
      )
      .returning();

    /*
     * One answer for every way this can fail. Whether a ticket was unknown,
     * spent, cancelled or merely late is useful to an operator reading the
     * audit trail and of no legitimate use to whoever presented it.
     */
    if (claimed.length !== 1) {
      throw AppError.unauthorized(
        'HOST_SETUP_TICKET_INVALID',
        'This installation command is no longer valid. Create a new one in Dockplane.',
      );
    }

    const setup = claimed[0];

    /*
     * The enrollment token is the existing one-time credential, unchanged: same
     * lifetime, same digest-only storage, same atomic consumption. The bootstrap
     * does not weaken it, it carries it — over TLS, in a response body, to a
     * machine that has just proved it holds the ticket.
     */
    const enrollmentToken = await this.enrollment.createToken(
      { id: setup.createdBy ?? undefined, email: 'host-setup' },
      { intendedHostname: setup.displayName ?? undefined, sourceIp: context.sourceIp },
    );

    await this.db.client
      .update(hostSetups)
      .set({ enrollmentTokenId: enrollmentToken.id, updatedAt: new Date() })
      .where(eq(hostSetups.id, setup.id));

    await this.audit.record({
      action: 'host.setup.bootstrapped',
      result: 'success',
      actorLabel: 'host-setup',
      targetType: 'host_setup',
      targetId: setup.id,
      targetLabel: setup.displayName ?? undefined,
      sourceIp: context.sourceIp,
    });

    return {
      setupId: setup.id,
      displayName: setup.displayName,
      enrollmentToken: enrollmentToken.token,
    };
  }

  /**
   * Reads a setup and records completion the first time it is demonstrably
   * finished.
   *
   * Completion is a fact about the world — a certificate was issued, a
   * connection exists, the host said what it is — so it is written down when it
   * is first observed rather than assumed when the command was handed out. The
   * update is conditional, so the audit entry happens exactly once however
   * often this is polled.
   */
  private async resolveAndSettle(id: string): Promise<HostSetupView> {
    const [row] = await this.resolve(id);

    if (!row) {
      throw AppError.notFound('HOST_SETUP_NOT_FOUND', 'This host setup does not exist.');
    }

    if (!isComplete(row) || row.setup.completedAt) {
      return view(row);
    }

    const now = new Date();

    const [settled] = await this.db.client
      .update(hostSetups)
      .set({ agentId: row.agentId, hostId: row.hostId, completedAt: now, updatedAt: now })
      .where(and(eq(hostSetups.id, id), isNull(hostSetups.completedAt)))
      .returning();

    if (!settled) {
      return view(row);
    }

    /*
     * The operator named the machine; the agent only knows what the machine
     * calls itself. The chosen name is applied to the host enrollment created.
     */
    if (settled.displayName && row.hostId) {
      await this.db.client
        .update(hosts)
        .set({ displayName: settled.displayName, updatedAt: now })
        .where(eq(hosts.id, row.hostId));
    }

    await this.audit.record({
      action: 'host.setup.completed',
      result: 'success',
      actorLabel: 'host-setup',
      targetType: 'host_setup',
      targetId: id,
      targetLabel: settled.displayName ?? undefined,
      reasonCode: row.agentId ?? undefined,
    });

    return view({ ...row, setup: settled });
  }

  /**
   * Follows the enrollment token a setup minted to whatever it became.
   *
   * A left join, because most setups have no token yet and a token has no agent
   * until somebody runs the command.
   */
  private async resolve(id?: string): Promise<ResolvedSetup[]> {
    const rows = await this.db.client
      .select({
        setup: hostSetups,
        agentId: agents.id,
        agentStatus: agents.status,
        hostId: agents.hostId,
        hostReportedOs: hosts.os,
      })
      .from(hostSetups)
      .leftJoin(
        agentEnrollmentTokens,
        eq(agentEnrollmentTokens.id, hostSetups.enrollmentTokenId),
      )
      .leftJoin(agents, eq(agents.id, agentEnrollmentTokens.consumedByAgentId))
      .leftJoin(hosts, eq(hosts.id, agents.hostId))
      .where(id ? eq(hostSetups.id, id) : undefined)
      .orderBy(desc(hostSetups.createdAt))
      .limit(id ? 1 : 100);

    return rows;
  }

  private ticketExpiry(from: Date = new Date()): Date {
    return new Date(from.getTime() + this.config.HOST_SETUP_TICKET_TTL * 1000);
  }
}

function progressOf(row: ResolvedSetup): HostSetupProgress {
  return {
    bootstrapped: Boolean(row.setup.ticketConsumedAt),
    enrolled: Boolean(row.agentId),
    connected: row.agentStatus === 'connected',
    inventoryReported: Boolean(row.hostReportedOs),
  };
}

function isComplete(row: ResolvedSetup): boolean {
  const progress = progressOf(row);

  return progress.enrolled && progress.connected && progress.inventoryReported;
}

function statusOf(row: ResolvedSetup, now: Date = new Date()): HostSetupStatus {
  if (row.setup.cancelledAt) {
    return 'cancelled';
  }

  if (row.setup.completedAt || isComplete(row)) {
    return 'connected';
  }

  if (row.setup.ticketConsumedAt) {
    return 'installing';
  }

  return row.setup.ticketExpiresAt.getTime() <= now.getTime() ? 'expired' : 'waiting';
}

function view(row: ResolvedSetup): HostSetupView {
  return {
    id: row.setup.id,
    displayName: row.setup.displayName,
    status: statusOf(row),
    progress: progressOf(row),
    createdAt: row.setup.createdAt,
    expiresAt: row.setup.ticketExpiresAt,
    agentId: row.agentId ?? row.setup.agentId,
    hostId: row.hostId ?? row.setup.hostId,
    completedAt: row.setup.completedAt,
  };
}

/** Keeps an operator's own label printable and bounded. It is never an identity. */
function normaliseDisplayName(value: string | undefined): string | null {
  const cleaned = (value ?? '').trim().replace(/\s+/g, ' ');

  return cleaned.slice(0, 120) || null;
}
