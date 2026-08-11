import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { Database } from '../database/database';
import { agents, hosts } from '../database/schema';

export interface AgentIdentity {
  readonly id: string;
  readonly hostId: string;
  readonly certificateFingerprint: string;
  readonly certificateSerial: string;
  readonly certificateNotAfter: Date;
  readonly protocolVersion: number;
  readonly revokedAt: Date | null;
}

/**
 * The agent registry.
 *
 * The database is authoritative for revocation. The gateway asks the registry
 * on every connection rather than caching a decision, so revoking an agent
 * takes effect on the next handshake instead of whenever a cache happens to
 * expire.
 */
@Injectable()
export class AgentRegistryService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** Resolves the identity a presented certificate maps to, if any. */
  async findByFingerprint(fingerprint: string): Promise<AgentIdentity | undefined> {
    const [row] = await this.db.client
      .select({
        id: agents.id,
        hostId: agents.hostId,
        certificateFingerprint: agents.certificateFingerprint,
        certificateSerial: agents.certificateSerial,
        certificateNotAfter: agents.certificateNotAfter,
        protocolVersion: agents.protocolVersion,
        revokedAt: agents.revokedAt,
      })
      .from(agents)
      .where(eq(agents.certificateFingerprint, fingerprint))
      .limit(1);

    return row;
  }

  async list() {
    return this.db.client
      .select({
        id: agents.id,
        hostId: agents.hostId,
        hostname: hosts.hostname,
        certificateSerial: agents.certificateSerial,
        certificateFingerprint: agents.certificateFingerprint,
        certificateNotAfter: agents.certificateNotAfter,
        version: agents.version,
        protocolVersion: agents.protocolVersion,
        status: agents.status,
        enrolledAt: agents.enrolledAt,
        firstSeenAt: agents.firstSeenAt,
        lastSeenAt: agents.lastSeenAt,
        revokedAt: agents.revokedAt,
        revocationReason: agents.revocationReason,
      })
      .from(agents)
      .innerJoin(hosts, eq(hosts.id, agents.hostId))
      .orderBy(desc(agents.enrolledAt))
      .limit(200);
  }

  async findById(id: string) {
    const [row] = await this.db.client
      .select({
        id: agents.id,
        hostId: agents.hostId,
        hostname: hosts.hostname,
        certificateSerial: agents.certificateSerial,
        certificateFingerprint: agents.certificateFingerprint,
        certificateNotAfter: agents.certificateNotAfter,
        version: agents.version,
        protocolVersion: agents.protocolVersion,
        capabilities: agents.capabilities,
        status: agents.status,
        enrolledAt: agents.enrolledAt,
        firstSeenAt: agents.firstSeenAt,
        lastSeenAt: agents.lastSeenAt,
        revokedAt: agents.revokedAt,
        revocationReason: agents.revocationReason,
      })
      .from(agents)
      .innerJoin(hosts, eq(hosts.id, agents.hostId))
      .where(eq(agents.id, id))
      .limit(1);

    return row;
  }

  /** Records that an authenticated agent is connected. */
  async markConnected(agentId: string, agentVersion?: string): Promise<void> {
    const now = new Date();

    await this.db.client
      .update(agents)
      .set({
        status: 'connected',
        lastSeenAt: now,
        firstSeenAt: undefined,
        version: agentVersion,
        updatedAt: now,
      })
      .where(eq(agents.id, agentId));

    // Set once, on the first successful handshake this agent ever completes.
    await this.db.client
      .update(agents)
      .set({ firstSeenAt: now })
      .where(and(eq(agents.id, agentId), isNull(agents.firstSeenAt)));
  }

  async touch(agentId: string): Promise<void> {
    await this.db.client
      .update(agents)
      .set({ lastSeenAt: new Date() })
      .where(eq(agents.id, agentId));
  }

  /**
   * Marks an agent disconnected.
   *
   * A revoked agent keeps its revoked status: losing the connection must not
   * quietly downgrade it to something that reads as recoverable.
   */
  async markDisconnected(agentId: string): Promise<void> {
    await this.db.client
      .update(agents)
      .set({ status: 'disconnected', updatedAt: new Date() })
      .where(and(eq(agents.id, agentId), isNull(agents.revokedAt)));
  }

  /**
   * Clears connection state left behind by a previous process.
   *
   * Without this a restart would leave agents reading as connected until they
   * happened to reconnect, which is exactly the stale-state-shown-as-live
   * problem the product is meant to avoid.
   */
  async resetConnectionState(): Promise<number> {
    const rows = await this.db.client
      .update(agents)
      .set({ status: 'disconnected', updatedAt: new Date() })
      .where(and(eq(agents.status, 'connected'), isNull(agents.revokedAt)))
      .returning({ id: agents.id });

    return rows.length;
  }

  async revoke(
    id: string,
    reason: string,
    actor: { id: string; email: string },
    context: { sourceIp?: string; userAgent?: string },
  ): Promise<void> {
    const revoked = await this.db.client
      .update(agents)
      .set({
        status: 'revoked',
        revokedAt: new Date(),
        revocationReason: reason,
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, id), isNull(agents.revokedAt)))
      .returning({ id: agents.id });

    if (revoked.length === 0) {
      const existing = await this.findById(id);

      throw existing
        ? AppError.conflict('AGENT_REVOKED', 'The agent credential is already revoked.')
        : AppError.notFound('AGENT_UNKNOWN', 'The agent does not exist.');
    }

    await this.audit.record({
      action: 'agent.revoked',
      result: 'success',
      actorUserId: actor.id,
      actorLabel: actor.email,
      targetType: 'agent',
      targetId: id,
      reasonCode: reason,
      sourceIp: context.sourceIp,
      userAgent: context.userAgent,
    });
  }

  /** Replaces the certificate an identity is recognised by, atomically. */
  async replaceCertificate(
    agentId: string,
    certificate: { fingerprintSha256: string; serialHex: string; notAfter: Date },
  ): Promise<void> {
    await this.db.client
      .update(agents)
      .set({
        certificateFingerprint: certificate.fingerprintSha256,
        certificateSerial: certificate.serialHex,
        certificateNotAfter: certificate.notAfter,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));
  }
}
