import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { generateSecret, hashSecret } from '../common/crypto';
import { AppConfig, CONFIG } from '../config/configuration';
import { Database } from '../database/database';
import { agentEnrollmentTokens, agents, hosts } from '../database/schema';
import { AgentCaService } from './agent-ca.service';
import { CertificateRequestError, parseCsr } from './pki';
import { PROTOCOL_VERSION, isSupportedProtocolVersion } from './protocol';

export interface CreatedEnrollmentToken {
  readonly id: string;
  /** Returned exactly once. Only its digest is persisted. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface EnrollmentRequest {
  readonly token: string;
  readonly csrPem: string;
  readonly agentVersion?: string;
  readonly protocolVersion: number;
  /** Declared by the agent and therefore not trusted for identity. */
  readonly declaredHostname?: string;
  readonly sourceIp?: string;
}

export interface EnrollmentResult {
  readonly agentId: string;
  readonly certificatePem: string;
  readonly caChainPem: string;
  readonly gatewayUrl: string;
  readonly protocolVersion: number;
  readonly certificateNotAfter: Date;
}

/**
 * Agent enrollment.
 *
 * An enrollment token is a one-time introduction, never a device credential:
 * it is exchanged once for a certificate and is then dead. The certificate that
 * replaces it carries an identity the control server chose, so nothing an agent
 * sends during enrollment can decide who it becomes.
 */
@Injectable()
export class EnrollmentService {
  constructor(
    private readonly db: Database,
    private readonly ca: AgentCaService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Mints a one-time token.
   *
   * The actor may have no user row: a host bootstrap mints a token on behalf of
   * whoever created the setup, and that account may since have been deleted.
   * The audit entry then records what did it rather than who.
   */
  async createToken(
    actor: { id?: string; email: string },
    options: { intendedHostname?: string; sourceIp?: string; userAgent?: string },
  ): Promise<CreatedEnrollmentToken> {
    const token = generateSecret();
    const expiresAt = new Date(Date.now() + this.config.AGENT_ENROLLMENT_TTL * 1000);

    const [created] = await this.db.client
      .insert(agentEnrollmentTokens)
      .values({
        tokenHash: hashSecret(token),
        createdBy: actor.id,
        intendedHostname: options.intendedHostname,
        expiresAt,
      })
      .returning({ id: agentEnrollmentTokens.id });

    await this.audit.record({
      action: 'agent.enrollment_token.created',
      result: 'success',
      actorUserId: actor.id,
      actorLabel: actor.email,
      targetType: 'enrollment_token',
      targetId: created.id,
      targetLabel: options.intendedHostname,
      sourceIp: options.sourceIp,
      userAgent: options.userAgent,
    });

    return { id: created.id, token, expiresAt };
  }

  async revokeToken(
    id: string,
    actor: { id: string; email: string },
    context: { sourceIp?: string; userAgent?: string },
  ): Promise<void> {
    const revoked = await this.db.client
      .update(agentEnrollmentTokens)
      .set({ revokedAt: new Date(), revokedBy: actor.id })
      .where(
        and(
          eq(agentEnrollmentTokens.id, id),
          isNull(agentEnrollmentTokens.revokedAt),
          isNull(agentEnrollmentTokens.consumedAt),
        ),
      )
      .returning({ id: agentEnrollmentTokens.id });

    if (revoked.length === 0) {
      throw AppError.notFound(
        'ENROLLMENT_TOKEN_INVALID',
        'The enrollment token does not exist, or was already used or revoked.',
      );
    }

    await this.audit.record({
      action: 'agent.enrollment_token.revoked',
      result: 'success',
      actorUserId: actor.id,
      actorLabel: actor.email,
      targetType: 'enrollment_token',
      targetId: id,
      sourceIp: context.sourceIp,
      userAgent: context.userAgent,
    });
  }

  /** Token metadata for administration. The raw token is never recoverable. */
  async listTokens() {
    return this.db.client
      .select({
        id: agentEnrollmentTokens.id,
        createdBy: agentEnrollmentTokens.createdBy,
        intendedHostname: agentEnrollmentTokens.intendedHostname,
        createdAt: agentEnrollmentTokens.createdAt,
        expiresAt: agentEnrollmentTokens.expiresAt,
        consumedAt: agentEnrollmentTokens.consumedAt,
        consumedByAgentId: agentEnrollmentTokens.consumedByAgentId,
        revokedAt: agentEnrollmentTokens.revokedAt,
      })
      .from(agentEnrollmentTokens)
      .orderBy(desc(agentEnrollmentTokens.createdAt))
      .limit(100);
  }

  /**
   * Exchanges a one-time token for a device certificate.
   *
   * Claiming the token, creating the identity and recording the certificate all
   * happen in one transaction, and the claim is a conditional update rather than
   * a read followed by a write. Two requests arriving with the same token
   * therefore cannot both succeed: the second finds nothing left to claim.
   */
  async enroll(request: EnrollmentRequest): Promise<EnrollmentResult> {
    if (!isSupportedProtocolVersion(request.protocolVersion)) {
      throw new AppError(
        'AGENT_PROTOCOL_UNSUPPORTED',
        `Protocol version ${request.protocolVersion} is not supported.`,
      );
    }

    // Validated before the token is spent, so a malformed request does not
    // consume the operator's one-time token.
    this.assertCsrAcceptable(request.csrPem);

    const claimed = await this.claimToken(request.token);
    const issued = await this.issueForClaimedToken(claimed.id, request);

    return issued;
  }

  /** Parsing performs the full key, size and extension validation. */
  private assertCsrAcceptable(csrPem: string): void {
    try {
      parseCsr(csrPem);
    } catch (error) {
      throw new AppError(
        'ENROLLMENT_CSR_INVALID',
        error instanceof CertificateRequestError
          ? error.message
          : 'The certificate request was not accepted.',
      );
    }
  }

  /**
   * Atomically claims a token.
   *
   * The distinction between expired, consumed and revoked is resolved by a
   * second read only after the claim fails, so the common path is a single
   * conditional write and the error still tells an operator what happened.
   */
  private async claimToken(token: string): Promise<{ id: string }> {
    const digest = hashSecret(token);
    const now = new Date();

    const claimed = await this.db.client
      .update(agentEnrollmentTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(agentEnrollmentTokens.tokenHash, digest),
          isNull(agentEnrollmentTokens.consumedAt),
          isNull(agentEnrollmentTokens.revokedAt),
          sql`${agentEnrollmentTokens.expiresAt} > ${now}`,
        ),
      )
      .returning({ id: agentEnrollmentTokens.id });

    if (claimed.length === 1) {
      return claimed[0];
    }

    const [existing] = await this.db.client
      .select({
        consumedAt: agentEnrollmentTokens.consumedAt,
        revokedAt: agentEnrollmentTokens.revokedAt,
        expiresAt: agentEnrollmentTokens.expiresAt,
      })
      .from(agentEnrollmentTokens)
      .where(eq(agentEnrollmentTokens.tokenHash, digest))
      .limit(1);

    if (!existing) {
      throw AppError.unauthorized('ENROLLMENT_TOKEN_INVALID', 'The enrollment token is not valid.');
    }

    if (existing.revokedAt) {
      throw AppError.unauthorized('ENROLLMENT_TOKEN_REVOKED', 'The enrollment token was revoked.');
    }

    if (existing.consumedAt) {
      throw AppError.unauthorized(
        'ENROLLMENT_TOKEN_CONSUMED',
        'The enrollment token has already been used.',
      );
    }

    throw AppError.unauthorized('ENROLLMENT_TOKEN_EXPIRED', 'The enrollment token has expired.');
  }

  private async issueForClaimedToken(
    tokenId: string,
    request: EnrollmentRequest,
  ): Promise<EnrollmentResult> {
    /*
     * The host row is a placeholder for the relation. Nothing here is inventory:
     * the hostname is what the agent claimed, kept only so an operator can
     * recognise the pending host, and every real attribute stays empty until an
     * agent reports it in a later milestone.
     */
    const declaredHostname = sanitiseHostname(request.declaredHostname);

    const agentId = await this.db.client.transaction(async (tx) => {
      const [host] = await tx
        .insert(hosts)
        .values({ hostname: declaredHostname })
        .returning({ id: hosts.id });

      const [agent] = await tx
        .insert(agents)
        .values({
          hostId: host.id,
          // Replaced below once the certificate exists; the row is created first
          // so the identity the certificate carries is the one already stored.
          certificateFingerprint: `pending:${tokenId}`,
          certificateSerial: 'pending',
          certificateNotAfter: new Date(0),
          version: request.agentVersion,
          protocolVersion: request.protocolVersion,
          status: 'pending',
        })
        .returning({ id: agents.id });

      await tx
        .update(agentEnrollmentTokens)
        .set({ consumedByAgentId: agent.id })
        .where(eq(agentEnrollmentTokens.id, tokenId));

      return agent.id;
    });

    let certificate;

    try {
      certificate = await this.ca.issueAgentCertificate(request.csrPem, agentId);
    } catch (error) {
      // The identity is useless without a certificate, so it is not left behind.
      await this.db.client.delete(agents).where(eq(agents.id, agentId));

      if (error instanceof CertificateRequestError) {
        throw new AppError('ENROLLMENT_CSR_INVALID', error.message);
      }

      throw error;
    }

    await this.db.client
      .update(agents)
      .set({
        certificateFingerprint: certificate.fingerprintSha256,
        certificateSerial: certificate.serialHex,
        certificateNotAfter: certificate.notAfter,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    await this.audit.record({
      action: 'agent.enrollment_token.consumed',
      result: 'success',
      actorLabel: 'agent-enrollment',
      targetType: 'enrollment_token',
      targetId: tokenId,
      sourceIp: request.sourceIp,
    });

    await this.audit.record({
      action: 'agent.enrolled',
      result: 'success',
      actorLabel: 'agent-enrollment',
      targetType: 'agent',
      targetId: agentId,
      targetLabel: declaredHostname,
      reasonCode: certificate.serialHex,
      sourceIp: request.sourceIp,
    });

    return {
      agentId,
      certificatePem: certificate.certificatePem,
      caChainPem: this.ca.chainPem,
      gatewayUrl: this.config.AGENT_GATEWAY_ADVERTISED_URL,
      protocolVersion: PROTOCOL_VERSION,
      certificateNotAfter: certificate.notAfter,
    };
  }
}

/** Keeps an agent-supplied name printable and bounded. It is never an identity. */
function sanitiseHostname(value: string | undefined): string {
  const cleaned = (value ?? '').trim().replace(/[^\w.-]/g, '');

  return cleaned.slice(0, 253) || 'unidentified-host';
}
