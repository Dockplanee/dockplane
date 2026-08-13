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
  /*
   * A host setup records what an operator did, never the material it produced.
   * The bootstrap ticket, the enrollment token and the script that carries them
   * are all absent from these entries by construction: the service only ever
   * passes an identifier.
   */
  | 'host.setup.created'
  | 'host.setup.regenerated'
  | 'host.setup.cancelled'
  | 'host.setup.bootstrapped'
  | 'host.setup.completed'
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
   * An operation the server finished on its own behalf, after the process that
   * started it stopped being able to. These carry the original action so the
   * trail reads as one operation an operator began and the server closed, not
   * as something a person did twice.
   */
  | 'container.create.requested'
  | 'container.create.succeeded'
  | 'container.create.failed'
  | 'container.replace.requested'
  | 'container.replace.succeeded'
  | 'container.replace.failed'
  | 'container.remove.requested'
  | 'container.remove.succeeded'
  | 'container.remove.failed'
  /*
   * Dispatched, and then nothing came back. Deliberately not "failed": the
   * server did not establish that the operation failed, and an operator reading
   * the trail later must not be told something nobody ever knew.
   */
  | 'container.create.interrupted'
  | 'container.replace.interrupted'
  | 'container.remove.interrupted'
  /*
   * A stack was saved, not deployed. The entry names the stack and the revision
   * number and nothing about what is in either — a Compose file and its
   * environment are exactly the things an audit trail must not carry.
   */
  | 'stack.created'
  | 'stack.revision.created'
  /*
   * A deployment, which is the first stack action that changes a host. The
   * entry names the stack and the revision it was deploying — never a service,
   * an image or anything out of the Compose file.
   */
  | 'stack.deploy.requested'
  | 'stack.deploy.succeeded'
  | 'stack.deploy.failed'
  | 'stack.deploy.interrupted'
  | 'stack.deploy.needs_attention'
  /*
   * The same operation under the words an operator would use for it: moving a
   * running stack to another revision, putting it back to an older one, and
   * converging one that was left half-applied. The entry names the stack and
   * the attempt, and nothing out of the Compose file.
   */
  | 'stack.redeploy.requested'
  | 'stack.redeployed'
  | 'stack.rollback.requested'
  | 'stack.rolled_back'
  | 'stack.repair.requested'
  | 'stack.repaired'
  /*
   * The attempt did not take and the host was put back as it was. Deliberately
   * not "rolled back to a revision": nothing was rolled back except this
   * attempt, and the stack is what it always was.
   */
  | 'stack.apply.rolled_back'
  /*
   * Moving a deployed stack between running and stopped.
   *
   * Recorded apart from applying a revision because it is a different claim:
   * nothing was deployed, and the revision the stack is running is the one it
   * was running before.
   */
  | 'stack.start.requested'
  | 'stack.started'
  | 'stack.start.failed'
  | 'stack.stop.requested'
  | 'stack.stopped'
  | 'stack.stop.failed'
  | 'stack.restart.requested'
  | 'stack.restarted'
  | 'stack.restart.failed'
  | 'stack.operation.interrupted'
  | 'stack.operation.needs_attention'
  | 'container.recovery.promoted'
  | 'container.recovery.discarded'
  | 'container.recovery.removed'
  | 'container.recovery.failed'
  | 'container.recovery.conflicted'
  | 'container.recovery.needs_attention'
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
