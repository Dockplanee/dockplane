import { AppError } from '../common/errors';

/**
 * Whether a host is still part of the working set.
 *
 * One function rather than a check per controller, so every refusal carries the
 * same code and the same sentence, and so adding an operation cannot quietly
 * add a different rule. Callers pass the host row they have already loaded:
 * the archived state is read from the record, never inferred from an agent
 * status, a last-seen time or a hostname.
 */

export interface ArchivableHost {
  readonly id: string;
  readonly archivedAt: Date | null;
}

/** Whether new operational work may be directed at this host. */
export function isArchived(host: ArchivableHost): boolean {
  return host.archivedAt !== null;
}

/**
 * Refuses new operational work against an archived host.
 *
 * Reading is never refused here. An archived host's containers, projects,
 * stacks and history stay visible exactly as they were — what archiving
 * withdraws is the host as a target, not the record of what it ran.
 */
export function assertNotArchived(host: ArchivableHost, what: string): void {
  if (isArchived(host)) {
    throw AppError.conflict(
      'HOST_ARCHIVED',
      `The host is archived, so ${what}. Restore it first if it is in use again.`,
    );
  }
}
