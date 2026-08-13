import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Logger } from 'pino';

import { AuditAction, AuditService } from '../audit/audit.service';
import { LOGGER } from '../config/tokens';
import { Database } from '../database/database';
import * as schema from '../database/schema';
import { actions, containerDesiredConfigs, containers } from '../database/schema';
import { RecoveryDecision, RecoveryOperation } from './recovery';

type Transaction = Parameters<Parameters<NodePgDatabase<typeof schema>['transaction']>[0]>[0];

/** The unfinished mutation a decision was made about. */
export interface RecoveryContext {
  readonly containerId: string;
  readonly containerName: string;
  readonly hostId: string;
  readonly operation: RecoveryOperation;
  /** The action the mutation recorded, absent if it died before writing one. */
  readonly actionId: string | null;
  /** The Docker containers observed claiming this resource, for a conflict. */
  readonly observedDockerIds?: readonly string[];
}

/**
 * Writing down what an interrupted mutation turned out to mean.
 *
 * The decision is made elsewhere, by a pure function over what was observed.
 * This is the half that touches the database, and it is deliberately the only
 * half that does: the classifier can be reasoned about without a database, and
 * this can be reasoned about without wondering what it might decide.
 *
 * Everything here runs in one short transaction and nothing here waits on an
 * agent, a host or a network. That is the whole reason the current/pending
 * split exists rather than a transaction held open across the Docker
 * operation: a transaction cannot roll back a container that was created, and
 * one that stays open across a dispatch pins a connection to a request that may
 * never return.
 *
 * Two reconciliation passes may reach the same unfinished mutation at once, so
 * each finalisation begins by claiming it. Whoever claims it does the work;
 * whoever does not returns false and writes nothing. Losing that race is the
 * normal outcome of two workers agreeing, not a failure.
 */
@Injectable()
export class RecoveryFinalizer {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Applies a decision.
   *
   * Returns whether this call was the one that finalised the mutation. Calling
   * it again returns false and changes nothing, which is what makes a
   * reconciliation pass safe to repeat.
   */
  async finalize(context: RecoveryContext, decision: RecoveryDecision): Promise<boolean> {
    if (decision.kind === 'no_action') {
      return false;
    }

    let outcome: Outcome | null;

    try {
      outcome = await this.db.client.transaction((tx) => this.apply(tx, context, decision));
    } catch (error) {
      if (!(error instanceof StaleRecovery)) {
        throw error;
      }

      /*
       * The state moved between the decision and applying it. Everything this
       * transaction had done goes back with it, and the next pass looks again
       * at whatever is there now.
       */
      this.logger.warn(
        {
          event: 'container_recovery_stale',
          containerId: context.containerId,
          actionId: context.actionId,
          decision: decision.kind,
        },
        'a recovery decision no longer described the container it was made about',
      );

      return false;
    }

    if (!outcome) {
      return false;
    }

    /*
     * Audited as a recovery, not as something a person did.
     *
     * The action keeps its original actor and correlation identifier, so the
     * trail still reads as one operation that an operator started and that the
     * server finished later, rather than two unrelated events.
     */
    await this.audit.record({
      action: outcome.action,
      result: outcome.result,
      actorLabel: 'container-recovery',
      targetType: 'container',
      targetId: context.containerId,
      targetLabel: context.containerName,
      reasonCode: context.actionId ?? outcome.reasonCode,
    });

    this.logger.info(
      {
        event: 'container_recovery_finalized',
        containerId: context.containerId,
        hostId: context.hostId,
        operation: context.operation,
        actionId: context.actionId,
        decision: decision.kind,
      },
      'an interrupted container mutation was finalised',
    );

    return true;
  }

  private async apply(
    tx: Transaction,
    context: RecoveryContext,
    decision: RecoveryDecision,
  ): Promise<Outcome | null> {
    switch (decision.kind) {
      case 'promote_pending':
        return this.promote(tx, context, decision.desiredConfigId);
      case 'discard_pending':
        return this.discard(tx, context, decision.desiredConfigId);
      case 'finalize_remove':
        return this.finalizeRemove(tx, context);
      case 'fail_operation':
        return this.failOperation(tx, context);
      case 'identity_conflict':
        return this.conflict(tx, context);
      case 'needs_attention':
        return this.needsAttention(tx, context);
      default:
        return null;
    }
  }

  /** The candidate is what is running, so it becomes what the container is. */
  private async promote(
    tx: Transaction,
    context: RecoveryContext,
    desiredConfigId: string,
  ): Promise<Outcome | null> {
    if (!(await this.claim(tx, context, desiredConfigId))) {
      return null;
    }

    /*
     * The old configuration goes first. Only one configuration per container
     * may be current — the database enforces it — so promoting before removing
     * would be rejected rather than overwriting anything.
     *
     * Its environment goes with it, which is the point: the values that are no
     * longer running, including the secrets among them, stop being stored.
     */
    await tx
      .delete(containerDesiredConfigs)
      .where(
        and(
          eq(containerDesiredConfigs.containerId, context.containerId),
          eq(containerDesiredConfigs.state, 'current'),
        ),
      );

    /*
     * Still the candidate it was when the decision was made. Restated here
     * rather than assumed from the claim above, so that promoting depends on
     * the row being what it was rather than on the reasoning that says it must
     * be.
     */
    const promoted = await tx
      .update(containerDesiredConfigs)
      .set({ state: 'current', actionId: null, updatedAt: new Date() })
      .where(
        and(
          eq(containerDesiredConfigs.id, desiredConfigId),
          eq(containerDesiredConfigs.state, 'pending'),
        ),
      )
      .returning({ id: containerDesiredConfigs.id });

    if (promoted.length === 0) {
      throw new StaleRecovery();
    }

    await this.finishAction(tx, context, 'succeeded');

    return { action: 'container.recovery.promoted', result: 'success' };
  }

  /** The candidate never took, so it is thrown away and the current one stays. */
  private async discard(
    tx: Transaction,
    context: RecoveryContext,
    desiredConfigId: string,
  ): Promise<Outcome | null> {
    if (!(await this.claim(tx, context, desiredConfigId))) {
      return null;
    }

    if (context.operation === 'create') {
      /*
       * A create that produced nothing. The resource was written before the
       * agent was asked, so nothing else refers to it and no container ever
       * carried its identity — it goes, and its configuration and environment
       * go with it. That also releases the name it was holding.
       *
       * Guarded on the resource still having no Docker container. If one was
       * observed between the decision and this, the state that was classified
       * is not the state in front of us any more, and the next pass should look
       * again rather than this one acting on a stale answer.
       */
      const [released] = await tx
        .delete(containers)
        .where(and(eq(containers.id, context.containerId), isNull(containers.dockerId)))
        .returning({ id: containers.id });

      if (!released) {
        return null;
      }

      await this.finishAction(tx, context, 'failed', 'CONTAINER_CREATE_FAILED');

      return { action: 'container.recovery.discarded', result: 'failure' };
    }

    const discarded = await tx
      .delete(containerDesiredConfigs)
      .where(
        and(
          eq(containerDesiredConfigs.id, desiredConfigId),
          eq(containerDesiredConfigs.state, 'pending'),
        ),
      )
      .returning({ id: containerDesiredConfigs.id });

    if (discarded.length === 0) {
      return null;
    }

    await this.finishAction(tx, context, 'failed', 'REPLACEMENT_FAILED');

    return { action: 'container.recovery.discarded', result: 'failure' };
  }

  /** The container is gone and was meant to be, so the resource follows it. */
  private async finalizeRemove(tx: Transaction, context: RecoveryContext): Promise<Outcome | null> {
    if (!(await this.claim(tx, context, null))) {
      return null;
    }

    /*
     * The configurations and their environment go with the row. A removed
     * container that left its secrets behind in the database would be a
     * removal that did not remove anything.
     */
    await tx.delete(containers).where(eq(containers.id, context.containerId));

    await this.finishAction(tx, context, 'succeeded');

    return { action: 'container.recovery.removed', result: 'success' };
  }

  /** The operation did not happen and left nothing behind to clean up. */
  private async failOperation(tx: Transaction, context: RecoveryContext): Promise<Outcome | null> {
    if (!(await this.claim(tx, context, null))) {
      return null;
    }

    await this.finishAction(tx, context, 'failed', 'CONTAINER_REMOVE_FAILED');

    return { action: 'container.recovery.failed', result: 'failure' };
  }

  /** More than one container claims the resource, so nobody may act on it. */
  private async conflict(tx: Transaction, context: RecoveryContext): Promise<Outcome | null> {
    if (!(await this.claim(tx, context, null))) {
      return null;
    }

    await tx
      .update(containers)
      .set({
        identityConflict: {
          dockerIds: [...(context.observedDockerIds ?? [])],
          observedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(containers.id, context.containerId));

    await this.finishAction(tx, context, 'failed', 'CONTAINER_IDENTITY_CONFLICT');

    return {
      action: 'container.recovery.conflicted',
      result: 'failure',
      reasonCode: 'CONTAINER_IDENTITY_CONFLICT',
    };
  }

  /**
   * The state cannot be resolved without a person.
   *
   * The candidate configuration deliberately stays where it is. It is what
   * keeps the container refusing further operations, which is the right
   * outcome: an operator who is told a container needs attention should not
   * find that it also quietly accepted a restart in the meantime.
   */
  private async needsAttention(tx: Transaction, context: RecoveryContext): Promise<Outcome | null> {
    if (!(await this.claim(tx, context, null))) {
      return null;
    }

    await this.finishAction(tx, context, 'failed', 'CONTAINER_STATE_UNRESOLVED');

    return {
      action: 'container.recovery.needs_attention',
      result: 'failure',
      reasonCode: 'CONTAINER_STATE_UNRESOLVED',
    };
  }

  /**
   * Takes ownership of the unfinished mutation, or reports that somebody else
   * already has.
   *
   * The action row is what is claimed where there is one: it is the record that
   * says an operation is unresolved, and moving it out of that state is the
   * single statement that decides the race. Where the mutation died before
   * writing one, the candidate configuration is claimed instead — held with a
   * row lock so a second worker blocks, then re-reads it, then finds it no
   * longer pending and steps aside.
   */
  private async claim(
    tx: Transaction,
    context: RecoveryContext,
    desiredConfigId: string | null,
  ): Promise<boolean> {
    if (context.actionId) {
      const claimed = await tx
        .select({ id: actions.id })
        .from(actions)
        .where(
          and(eq(actions.id, context.actionId), inArray(actions.status, ['queued', 'running'])),
        )
        .for('update');

      return claimed.length > 0;
    }

    if (!desiredConfigId) {
      /*
       * Nothing to claim: no action was recorded and there is no candidate.
       * Reconciliation has no way to tell two workers apart here, so it refuses
       * rather than letting both act.
       */
      this.logger.warn(
        {
          event: 'container_recovery_unclaimable',
          containerId: context.containerId,
          operation: context.operation,
        },
        'an interrupted mutation could not be attributed to an action',
      );

      return false;
    }

    const claimed = await tx
      .select({ id: containerDesiredConfigs.id })
      .from(containerDesiredConfigs)
      .where(
        and(
          eq(containerDesiredConfigs.id, desiredConfigId),
          eq(containerDesiredConfigs.state, 'pending'),
          isNull(containerDesiredConfigs.actionId),
        ),
      )
      .for('update');

    return claimed.length > 0;
  }

  /** Closes the action the operator started, without inventing a new one. */
  private async finishAction(
    tx: Transaction,
    context: RecoveryContext,
    status: 'succeeded' | 'failed',
    errorCode?: string,
  ): Promise<void> {
    if (!context.actionId) {
      return;
    }

    await tx
      .update(actions)
      .set({ status, completedAt: new Date(), errorCode })
      .where(eq(actions.id, context.actionId));
  }
}

interface Outcome {
  readonly action: AuditAction;
  readonly result: 'success' | 'failure';
  readonly reasonCode?: string;
}

/**
 * Raised when the rows are no longer what the decision described.
 *
 * Thrown rather than returned because by the time it is noticed the
 * transaction has already changed something, and rolling back is the point:
 * a half-applied promotion is the one outcome worse than none.
 */
class StaleRecovery extends Error {
  constructor() {
    super('the recovery decision no longer applies');
  }
}
