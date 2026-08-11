import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, SQL } from 'drizzle-orm';
import { Logger } from 'pino';

import { LOGGER } from '../config/tokens';
import { Database } from '../database/database';
import { auditEntries } from '../database/schema';
import { currentContext } from '../logging/logger';

export type AuditAction =
  | 'auth.login.succeeded'
  | 'auth.login.failed'
  | 'auth.logout'
  | 'auth.mfa.challenge.failed'
  | 'session.revoked'
  | 'user.bootstrapped'
  | 'mfa.enabled'
  | 'mfa.disabled'
  | 'mfa.recovery_code.used'
  | 'mfa.recovery_codes.regenerated'
  | 'role.assigned'
  | 'agent.enrollment_token.created'
  | 'agent.enrollment_token.revoked'
  | 'agent.enrollment_token.consumed'
  | 'agent.enrolled'
  | 'agent.revoked'
  | 'agent.certificate.renewed'
  | 'container.start.requested'
  | 'container.start.succeeded'
  | 'container.start.failed'
  | 'container.stop.requested'
  | 'container.stop.succeeded'
  | 'container.stop.failed'
  | 'container.restart.requested'
  | 'container.restart.succeeded'
  | 'container.restart.failed'
  /*
   * A log stream is recorded as an event, never as content.
   *
   * The entry says who opened a stream against which container and how it
   * ended. What the container printed is not part of it: the audit trail is
   * read by people who may not hold the permission that allowed the stream.
   */
  | 'container.logs.opened'
  | 'container.logs.closed';

export interface AuditRecord {
  readonly action: AuditAction;
  readonly result: 'success' | 'failure';
  readonly actorUserId?: string;
  /** Human-readable actor, used when no user row applies, such as a CLI run. */
  readonly actorLabel: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly targetLabel?: string;
  /** Stable machine-readable reason. Never a message containing user input. */
  readonly reasonCode?: string;
  readonly sourceIp?: string;
  readonly userAgent?: string;
}

/**
 * Security trail.
 *
 * The record shape accepts only identifiers, labels and reason codes. There is
 * deliberately no free-form detail field: a caller cannot pass a password, a
 * token or a recovery code into an audit row even by accident.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly db: Database,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async record(entry: AuditRecord): Promise<void> {
    const requestId = currentContext()?.requestId;

    await this.db.client.insert(auditEntries).values({
      actorUserId: entry.actorUserId,
      actorLabel: entry.actorLabel,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      targetLabel: entry.targetLabel,
      result: entry.result,
      reasonCode: entry.reasonCode,
      sourceIp: entry.sourceIp,
      userAgent: entry.userAgent?.slice(0, 256),
      requestId,
    });

    this.logger.info(
      {
        event: 'audit',
        action: entry.action,
        result: entry.result,
        targetType: entry.targetType,
        reasonCode: entry.reasonCode,
      },
      'audit entry recorded',
    );
  }

  /** Keyset pagination, so a growing log does not degrade into large offsets. */
  async list(options: { limit: number; before?: Date; action?: string }) {
    const filters: SQL[] = [];

    if (options.before) {
      filters.push(lt(auditEntries.occurredAt, options.before));
    }

    if (options.action) {
      filters.push(eq(auditEntries.action, options.action));
    }

    return this.db.client
      .select()
      .from(auditEntries)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(auditEntries.occurredAt))
      .limit(options.limit);
  }
}
