import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { AppError } from '../common/errors';
import { Database } from '../database/database';
import { containerDesiredConfigs, containers } from '../database/schema';

/**
 * What is still unfinished, according to the database rather than to memory.
 *
 * The in-memory lock stops two operations racing inside one running process,
 * and it is the right tool for that: it is immediate and it costs nothing. But
 * it is also the first thing a restart forgets, and a control server that dies
 * partway through a replacement leaves behind a container whose state nobody
 * can describe — the candidate was written, Docker may or may not have applied
 * it, and until reconciliation says which, no further operation on that
 * container has a defined meaning.
 *
 * So both guards exist, and they answer different questions. The lock answers
 * "is something running right now"; this answers "did something never finish".
 * A restart clears the first and leaves the second exactly as it was.
 *
 * Recovery does not go through here. Finalising an unfinished mutation is the
 * one thing that must be allowed to touch one, and it reaches the rows through
 * its own path rather than through a flag that would turn this guard off.
 */
@Injectable()
export class PendingMutationGuard {
  constructor(private readonly db: Database) {}

  /**
   * Refuses an operation on a container whose last mutation never resolved.
   *
   * Checked before the container is resolved to a Docker identifier, because
   * during a replacement that identifier is the thing in question: resolving
   * first would mean reading an address that is being replaced and only then
   * discovering that nobody may act on it.
   */
  async assertResolved(containerId: string): Promise<void> {
    const [pending] = await this.db.client
      .select({ id: containerDesiredConfigs.id })
      .from(containerDesiredConfigs)
      .where(
        and(
          eq(containerDesiredConfigs.containerId, containerId),
          eq(containerDesiredConfigs.state, 'pending'),
        ),
      );

    if (pending) {
      // The code every other busy container has answered with. A new one would
      // say the same thing to a client that had already learned this one.
      throw AppError.conflict(
        'ACTION_CONFLICT',
        'A configuration change on this container has not been resolved yet.',
      );
    }
  }

  /**
   * Refuses a create whose name an unfinished create already holds.
   *
   * A create has no container to hold, so it holds the resource it wrote: the
   * row exists before Docker has made anything, carries the intended name, and
   * has no Docker identifier until something is observed. Two creates of one
   * name would otherwise both proceed after a restart, and the second would
   * either collide with a name Docker had already taken or take it first and
   * leave two resources believing they owned it.
   *
   * The database refuses the duplicate as well. This is here so the caller is
   * told what is happening rather than shown a constraint violation.
   */
  async assertNameFree(hostId: string, name: string): Promise<void> {
    const [reserved] = await this.db.client
      .select({ id: containers.id })
      .from(containers)
      .where(
        and(
          eq(containers.hostId, hostId),
          isNull(containers.dockerId),
          sql`lower(${containers.name}) = lower(${name})`,
        ),
      );

    if (reserved) {
      throw AppError.conflict(
        'ACTION_CONFLICT',
        'A container with this name is already being created on this host.',
      );
    }
  }
}
