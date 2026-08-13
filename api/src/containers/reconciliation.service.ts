import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { Logger } from 'pino';

import { LOGGER } from '../config/tokens';
import { Database } from '../database/database';
import { agents, containerDesiredConfigs, containers } from '../database/schema';
import { DiscoveryService } from '../discovery/discovery.service';
import { RecoveryDecision, RecoveryOperation, classifyRecovery } from './recovery';
import { RecoveryFinalizer } from './recovery-finalizer';

/**
 * Reading the host, deciding what happened, and writing it down.
 *
 * The step between an agent answering and an operation being over. It exists as
 * one function because the three parts have to happen in that order and with
 * nothing in between: what the host actually has, then the decision, then the
 * record. Anything that decided first and looked afterwards would be recording
 * an expectation.
 *
 * It never dispatches. A create that did not happen is not created again here,
 * and neither is a removal that did not take — reconciliation establishes what
 * is true, and asking for the operation again is a decision for a person or for
 * a retry mechanism that does not exist yet.
 *
 * There are two callers and they differ in one thing only. A mutation that is
 * still running owns its container and asks about its own operation; a
 * reconciliation pass that finds an unfinished operation nobody owns asks about
 * somebody else's. Both use the same evidence and the same decision — the
 * difference is who is entitled to ask, and that is the caller's to establish.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly db: Database,
    private readonly discovery: DiscoveryService,
    private readonly finalizer: RecoveryFinalizer,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Asks the host what it has, then finalises the operation against the answer.
   *
   * Returns the decision that was reached, so a caller can report the outcome
   * of its own operation. A decision is not a promise that anything was
   * written: another pass may have finalised the same operation first, which is
   * an ordinary outcome and not an error.
   */
  async reconcileAndFinalize(operation: PendingOperation): Promise<RecoveryDecision> {
    const snapshotComplete = await this.resync(operation.hostId);
    const decision = await this.classify(operation, snapshotComplete);

    if (decision.kind !== 'no_action') {
      await this.finalizer.finalize(
        {
          containerId: operation.containerId,
          containerName: operation.containerName,
          hostId: operation.hostId,
          operation: operation.operation,
          actionId: operation.actionId,
          observedDockerIds: await this.claimedDockerIds(operation.containerId),
        },
        decision,
      );
    }

    this.logger.info(
      {
        event: 'container_operation_reconciled',
        containerId: operation.containerId,
        hostId: operation.hostId,
        operation: operation.operation,
        actionId: operation.actionId,
        snapshotComplete,
        decision: decision.kind,
      },
      'a container operation was reconciled against the host',
    );

    return decision;
  }

  /**
   * Decides without writing anything.
   *
   * Separate so the decision can be examined — by a test, or by a caller that
   * wants to report an outcome it is not entitled to act on.
   */
  async classify(
    operation: PendingOperation,
    snapshotComplete: boolean,
  ): Promise<RecoveryDecision> {
    const [container] = await this.db.client
      .select()
      .from(containers)
      .where(eq(containers.id, operation.containerId));

    const configs = await this.db.client
      .select()
      .from(containerDesiredConfigs)
      .where(eq(containerDesiredConfigs.containerId, operation.containerId));

    /*
     * What the resource looks like from the host.
     *
     * A resource with no Docker container is not a container that vanished —
     * for a create it is one that was never made. Either way there is nothing
     * claiming it, which is exactly what the classifier is asked to interpret.
     */
    const claims = container?.dockerId
      ? [{ dockerId: container.dockerId, desiredConfigId: container.observedDesiredConfigId }]
      : [];

    return classifyRecovery({
      operation: operation.operation,
      currentDesiredConfigId: configs.find((row) => row.state === 'current')?.id ?? null,
      pendingDesiredConfigId: configs.find((row) => row.state === 'pending')?.id ?? null,
      claims,
      snapshotComplete,
      recoveryEligible: true,
      identityConflict: Boolean(container?.identityConflict),
    });
  }

  /**
   * Reads the host again, and says whether the answer was complete.
   *
   * Completeness is the whole point of asking. A container that is absent from
   * a pass that failed halfway says nothing at all, and every decision that
   * turns on absence — a create that produced nothing, a removal that worked —
   * would otherwise be made from a gap in the evidence.
   */
  private async resync(hostId: string): Promise<boolean> {
    const [agent] = await this.db.client
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.hostId, hostId), isNull(agents.revokedAt)));

    if (!agent) {
      return false;
    }

    try {
      return (await this.discovery.sync(agent.id)).complete;
    } catch (error) {
      this.logger.warn(
        {
          event: 'container_reconcile_sync_failed',
          hostId,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'the host could not be read while reconciling an operation',
      );

      return false;
    }
  }

  /** The Docker containers on record as claiming this resource. */
  private async claimedDockerIds(containerId: string): Promise<string[]> {
    const [row] = await this.db.client
      .select({ identityConflict: containers.identityConflict, dockerId: containers.dockerId })
      .from(containers)
      .where(eq(containers.id, containerId));

    return row?.identityConflict
      ? [...row.identityConflict.dockerIds]
      : row?.dockerId
        ? [row.dockerId]
        : [];
  }
}

/** An operation that has been started and not yet resolved. */
export interface PendingOperation {
  readonly containerId: string;
  readonly containerName: string;
  readonly hostId: string;
  readonly operation: RecoveryOperation;
  readonly actionId: string | null;
}
