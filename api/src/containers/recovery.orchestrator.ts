import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Logger } from 'pino';

import { LOGGER } from '../config/tokens';
import { Database } from '../database/database';
import { actions, containers } from '../database/schema';
import { MutationRegistry } from '../operations/mutation-registry';
import { PendingOperation, ReconciliationService } from './reconciliation.service';
import { RecoveryOperation } from './recovery';

const MANAGEMENT = ['container.create', 'container.replace', 'container.remove'];

/**
 * Finishing what an earlier process started.
 *
 * A container change is owned by the request that started it, from the lock it
 * takes to the reconciliation it performs afterwards. This is for the changes
 * that lost their owner: the server was restarted, or the connection carrying
 * the answer died, and an operation is sitting open with nobody left to finish
 * it.
 *
 * Two conditions, both necessary. Nothing in memory may claim the container —
 * an operation with a live owner is that owner's to complete, and stepping in
 * would destroy an operation in progress. And the host has to have been read
 * completely, because most of these decisions turn on something being absent,
 * and absence from a partial reading is not evidence of anything.
 *
 * Neither of them is a schedule. There is no sweep, no interval and no
 * background scan: recovery runs when a host becomes readable again, against
 * the operations of that host, and does nothing at all otherwise.
 */
@Injectable()
export class RecoveryOrchestrator implements OnApplicationBootstrap {
  constructor(
    private readonly db: Database,
    private readonly mutations: MutationRegistry,
    private readonly reconciliation: ReconciliationService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Says what was left open, and settles none of it.
   *
   * A control server that has just started has heard from no host. Every
   * operation it finds here is unresolved precisely because nothing can be
   * observed yet, and acting would mean acting on no evidence at all. So this
   * reports, and the operations are settled one host at a time as each becomes
   * readable again.
   */
  async onApplicationBootstrap(): Promise<void> {
    const open = await this.db.client
      .select({ id: actions.id })
      .from(actions)
      .where(
        and(
          inArray(actions.status, ['queued', 'running']),
          inArray(actions.capability, MANAGEMENT),
        ),
      );

    if (open.length > 0) {
      this.logger.warn(
        { event: 'container_operations_unfinished', unresolved: open.length },
        'container operations were left unfinished and will be settled as their hosts are read',
      );
    }
  }

  /**
   * Settles what a host's unfinished operations turned out to mean.
   *
   * Called when a host has just been read completely — after an agent
   * reconnects, and at startup for hosts that are already reachable. An
   * operation whose host cannot be read is left exactly as it is: a missing
   * agent is not evidence that a container is missing.
   */
  async recoverHost(hostId: string): Promise<number> {
    const unfinished = await this.unresolved(hostId);
    let recovered = 0;

    for (const operation of unfinished) {
      if (this.mutations.isBusy(operation.containerId)) {
        // Somebody is running this right now and will finish it themselves.
        continue;
      }

      const decision = await this.reconciliation.reconcileAndFinalize(operation);

      if (decision.kind !== 'no_action') {
        recovered += 1;
      }
    }

    if (unfinished.length > 0) {
      this.logger.info(
        {
          event: 'container_recovery_pass',
          hostId,
          unresolved: unfinished.length,
          recovered,
        },
        'unfinished container operations were reconciled',
      );
    }

    return recovered;
  }

  /**
   * Everything left open on a host, from the record rather than from memory.
   *
   * After a restart the registry is empty and this is all there is — which is
   * the reason the operation was written down before the agent was asked.
   */
  private async unresolved(hostId: string): Promise<PendingOperation[]> {
    /*
     * Left-joined, because the resource may already be gone.
     *
     * A removal that lost its answer, followed by a discovery pass that found
     * the container missing, leaves the row deleted and the operation still
     * open. Requiring the resource to exist would leave that action open
     * forever — and it is one of the cases with a clear answer.
     */
    const rows = await this.db.client
      .select({
        actionId: actions.id,
        capability: actions.capability,
        targetId: actions.targetId,
        containerName: containers.name,
      })
      .from(actions)
      .leftJoin(containers, sql`${containers.id}::text = ${actions.targetId}`)
      .where(
        and(
          eq(actions.hostId, hostId),
          eq(actions.targetType, 'container'),
          inArray(actions.status, ['queued', 'running']),
          inArray(actions.capability, MANAGEMENT),
        ),
      );

    return rows
      .filter((row): row is typeof row & { targetId: string } => Boolean(row.targetId))
      .map((row) => ({
        containerId: row.targetId,
        containerName: row.containerName ?? 'a removed container',
        hostId,
        operation: row.capability.replace('container.', '') as RecoveryOperation,
        actionId: row.actionId,
      }));
  }
}
