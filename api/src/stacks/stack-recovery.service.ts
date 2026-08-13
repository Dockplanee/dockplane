import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Logger } from 'pino';

import { AuditService } from '../audit/audit.service';
import { LOGGER } from '../config/tokens';
import { Database } from '../database/database';
import {
  actions,
  agents,
  containers,
  stackDeployments,
  stackOperations,
  stackRevisions,
  stacks,
} from '../database/schema';
import { DetailService } from '../discovery/detail.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { MutationRegistry } from '../operations/mutation-registry';
import { ObservedService, classifyStackApply } from './stack-deployment';
import { UNRESOLVED_DEPLOYMENT, stackKey } from './stack-deployment.service';
import { ObservedRuntime, StackLifecycleKind, classifyStackLifecycle } from './stack-lifecycle';
import { UNRESOLVED_OPERATION } from './stack-lifecycle.service';

/**
 * Finishing a deployment whose owner is gone.
 *
 * A deployment is owned by the request that started it, from the lock it takes
 * to the reading of the host it does afterwards. This is for the ones that lost
 * their owner: the server was restarted, or the connection carrying the answer
 * died, and an attempt is sitting open with containers on a host and nobody
 * left to say what they mean.
 *
 * The conditions are the container recovery's, and for the same reasons.
 * Nothing in memory may claim the stack, because an attempt with a live owner
 * is that owner's to finish. And the host has to have been read completely,
 * because every conclusion turns on a container being there or not being there.
 *
 * Nothing is dispatched here. A deployment that half-happened is not attempted
 * again and nothing it created is removed: recovery establishes what is true,
 * and what to do about a stack that is half up is a decision for a person.
 */
@Injectable()
export class StackRecoveryService implements OnApplicationBootstrap {
  constructor(
    private readonly db: Database,
    private readonly mutations: MutationRegistry,
    private readonly discovery: DiscoveryService,
    private readonly detail: DetailService,
    private readonly audit: AuditService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Says what was left open, and settles none of it.
   *
   * A server that has just started has heard from no host, so every attempt it
   * finds is unresolved precisely because nothing can be observed yet.
   */
  async onApplicationBootstrap(): Promise<void> {
    const open = await this.db.client
      .select({ id: stackDeployments.id })
      .from(stackDeployments)
      .where(inArray(stackDeployments.status, [...UNRESOLVED_DEPLOYMENT]));

    if (open.length > 0) {
      this.logger.warn(
        { event: 'stack_deployments_unfinished', unresolved: open.length },
        'stack deployments were left unfinished and will be settled as their hosts are read',
      );
    }
  }

  /**
   * Settles what a host's unfinished deployments turned out to mean.
   *
   * The host is read here rather than on the caller's word. Everything below
   * turns on a container being present or absent, and a pass that stopped
   * halfway establishes neither — so this establishes it itself, and does so
   * only when there is something open to settle.
   *
   * A deployment already waiting for a person is left waiting: `needs_attention`
   * is not a state another reading of the host can resolve.
   */
  async recoverHost(hostId: string): Promise<number> {
    const unfinished = await this.db.client
      .select({
        id: stackDeployments.id,
        stackId: stackDeployments.stackId,
        revisionId: stackDeployments.revisionId,
        fromRevisionId: stackDeployments.fromRevisionId,
        actionId: stackDeployments.actionId,
        name: stacks.name,
      })
      .from(stackDeployments)
      .innerJoin(stacks, eq(stacks.id, stackDeployments.stackId))
      .where(
        and(
          eq(stackDeployments.hostId, hostId),
          inArray(stackDeployments.status, ['pending', 'running', 'interrupted']),
        ),
      );

    const operations = await this.unfinishedOperations(hostId);

    if (unfinished.length === 0 && operations.length === 0) {
      return 0;
    }

    if (!(await this.readCompletely(hostId))) {
      this.logger.info(
        {
          event: 'stack_recovery_deferred',
          hostId,
          unresolved: unfinished.length + operations.length,
        },
        'unfinished stack work was left as it is: the host could not be read completely',
      );

      return 0;
    }

    let recovered = 0;

    for (const deployment of unfinished) {
      if (this.mutations.isBusy(stackKey(deployment.stackId))) {
        // Somebody is running this right now and will finish it themselves.
        continue;
      }

      if (await this.settle(deployment, hostId)) {
        recovered += 1;
      }
    }

    for (const operation of operations) {
      if (this.mutations.isBusy(stackKey(operation.stackId))) {
        continue;
      }

      if (await this.settleOperation(operation, hostId)) {
        recovered += 1;
      }
    }

    this.logger.info(
      {
        event: 'stack_recovery_pass',
        hostId,
        unresolved: unfinished.length,
        recovered,
      },
      'unfinished stack deployments were reconciled',
    );

    return recovered;
  }

  /** Operations on this host's stacks that never resolved. */
  private async unfinishedOperations(hostId: string): Promise<readonly UnfinishedOperation[]> {
    const rows = await this.db.client
      .select({
        id: stackOperations.id,
        stackId: stackOperations.stackId,
        revisionId: stackOperations.revisionId,
        type: stackOperations.type,
        fingerprint: stackOperations.fingerprint,
        actionId: stackOperations.actionId,
        name: stacks.name,
      })
      .from(stackOperations)
      .innerJoin(stacks, eq(stacks.id, stackOperations.stackId))
      .where(
        and(
          eq(stackOperations.hostId, hostId),
          inArray(stackOperations.status, [...UNRESOLVED_OPERATION]),
        ),
      );

    return rows.map((row) => ({ ...row, type: row.type as StackLifecycleKind }));
  }

  /**
   * Settles one operation whose answer never came back.
   *
   * A start and a stop are settled from the state the host is in. A restart is
   * not: the stack it was asked to restart was running before and is running
   * now, and nothing else about the containers changed. It is settled against
   * the record of what each service looked like at the moment it was
   * dispatched, and a restart that cannot be demonstrated is not concluded to
   * have happened.
   */
  private async settleOperation(
    operation: UnfinishedOperation,
    hostId: string,
  ): Promise<boolean> {
    const observed = await this.observedRuntime(
      operation.stackId,
      operation.type === 'restart',
    );

    const outcome = classifyStackLifecycle({
      operation: operation.type,
      revisionId: operation.revisionId,
      expectedServices: await this.services(operation.revisionId),
      observed,
      fingerprint: operation.fingerprint?.services,
      // Read completely just above, which is the only reason anything may be
      // concluded here at all.
      snapshotComplete: true,
    });

    if (outcome.kind === 'unknown') {
      return false;
    }

    const now = new Date();
    const applied = outcome.kind === 'applied';
    const attention = outcome.kind === 'needs_attention';

    await this.db.client.transaction(async (tx) => {
      await tx
        .update(stackOperations)
        .set({
          status: OPERATION_STATUS[outcome.kind],
          detail: {
            services: observed
              .filter((service) => service.dockerId !== null)
              .map((service) => ({
                serviceName: service.serviceName,
                containerId: service.containerId,
                ...(service.state ? { state: service.state } : {}),
              })),
          },
          resolvedAt: now,
          ...(applied
            ? {}
            : {
                failureCode: attention
                  ? 'STACK_LIFECYCLE_PARTIAL'
                  : OPERATION_FAILED[operation.type],
              }),
          updatedAt: now,
        })
        .where(eq(stackOperations.id, operation.id));

      /*
       * The revision the stack is running is never written here. An operation
       * does not deploy anything, so whatever it turned out to have done, what
       * is deployed is what was deployed.
       */
      if (applied || attention) {
        await tx
          .update(stacks)
          .set({
            status: attention ? 'needs_attention' : RUNTIME_STATUS[operation.type],
            updatedAt: now,
          })
          .where(eq(stacks.id, operation.stackId));
      }

      if (operation.actionId) {
        await tx
          .update(actions)
          .set({
            status: applied ? 'succeeded' : 'failed',
            completedAt: now,
            ...(applied
              ? {}
              : {
                  errorCode: attention
                    ? 'STACK_LIFECYCLE_PARTIAL'
                    : OPERATION_FAILED[operation.type],
                }),
          })
          .where(eq(actions.id, operation.actionId));
      }
    });

    await this.audit.record({
      action: applied
        ? OPERATION_AUDIT[operation.type]
        : attention
          ? 'stack.operation.needs_attention'
          : OPERATION_AUDIT_FAILED[operation.type],
      result: applied ? 'success' : 'failure',
      actorLabel: 'system',
      targetType: 'stack',
      targetId: operation.stackId,
      targetLabel: operation.name,
      reasonCode: operation.id,
    });

    this.logger.info(
      {
        event: 'stack_operation_recovered',
        hostId,
        stackId: operation.stackId,
        operationId: operation.id,
        operation: operation.type,
        outcome: outcome.kind,
      },
      'an unfinished stack operation was settled from the host',
    );

    return true;
  }

  /**
   * The stack's services as the host shows them.
   *
   * Start times only for a restart, because only a restart needs them and each
   * one costs an inspect.
   */
  private async observedRuntime(
    stackId: string,
    withStartTimes: boolean,
  ): Promise<readonly ObservedRuntime[]> {
    const rows = await this.db.client
      .select({
        id: containers.id,
        dockerId: containers.dockerId,
        state: containers.state,
        stackService: containers.stackService,
        stackRevisionId: containers.stackRevisionId,
      })
      .from(containers)
      .where(eq(containers.stackId, stackId));

    const observed: ObservedRuntime[] = [];

    for (const row of rows) {
      let startedAt: string | null = null;

      if (withStartTimes && row.dockerId) {
        try {
          const detail = await this.detail.containerDetail(row.id, { force: true });

          startedAt = detail.detail?.startedAt ?? null;
        } catch {
          startedAt = null;
        }
      }

      observed.push({
        serviceName: row.stackService ?? '',
        containerId: row.id,
        dockerId: row.dockerId,
        state: row.dockerId ? row.state : null,
        revisionId: row.stackRevisionId,
        startedAt,
      });
    }

    return observed;
  }

  /** Reads the host, and says whether the answer was complete. */
  private async readCompletely(hostId: string): Promise<boolean> {
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
          event: 'stack_recovery_sync_failed',
          hostId,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'the host could not be read while settling an unfinished stack deployment',
      );

      return false;
    }
  }

  /** Compares one attempt with the host and writes what it turned out to be. */
  private async settle(deployment: Unfinished, hostId: string): Promise<boolean> {
    const rows = await this.db.client
      .select({
        id: containers.id,
        dockerId: containers.dockerId,
        state: containers.state,
        stackService: containers.stackService,
        stackRevisionId: containers.stackRevisionId,
      })
      .from(containers)
      .where(eq(containers.stackId, deployment.stackId));

    const observed: ObservedService[] = rows.map((row) => ({
      serviceName: row.stackService ?? '',
      containerId: row.id,
      dockerId: row.dockerId,
      state: row.dockerId ? row.state : null,
      revisionId: row.stackRevisionId,
    }));

    // The host was read completely just above, which is the only reason
    // anything may be concluded here at all.
    const outcome = classifyStackApply({
      fromRevisionId: deployment.fromRevisionId,
      targetRevisionId: deployment.revisionId,
      targetServices: await this.services(deployment.revisionId),
      fromServices: deployment.fromRevisionId
        ? await this.services(deployment.fromRevisionId)
        : null,
      observed,
      snapshotComplete: true,
    });

    if (outcome.kind === 'unknown') {
      return false;
    }

    const now = new Date();
    const detail = {
      services: observed
        .filter((service) => service.dockerId !== null)
        .map((service) => ({
          serviceName: service.serviceName,
          containerId: service.containerId,
          ...(service.state ? { state: service.state } : {}),
        })),
    };

    const applied = outcome.kind === 'finalize_target';
    const attention = outcome.kind === 'needs_attention';

    await this.db.client.transaction(async (tx) => {
      await tx
        .update(stackDeployments)
        .set({
          status: STATUS[outcome.kind],
          detail,
          resolvedAt: now,
          ...(applied ? {} : { failureCode: FAILURE_CODE[outcome.kind] }),
          updatedAt: now,
        })
        .where(eq(stackDeployments.id, deployment.id));

      if (applied) {
        await tx
          .update(stacks)
          .set({
            currentRevisionId: deployment.revisionId,
            desiredRevisionId: null,
            status: 'running',
            lastDeployedAt: now,
            updatedAt: now,
          })
          .where(eq(stacks.id, deployment.stackId));
      } else {
        /*
         * The stack is what it was. Its confirmed revision is deliberately not
         * written here: it never changed, and an attempt that did not take has
         * nothing to say about it.
         */
        await tx
          .update(stacks)
          .set({
            status: attention
              ? 'needs_attention'
              : deployment.fromRevisionId
                ? 'running'
                : 'not_deployed',
            desiredRevisionId: null,
            updatedAt: now,
          })
          .where(eq(stacks.id, deployment.stackId));
      }

      if (!attention) {
        /*
         * Resources that name a container the host does not have. Removed only
         * in these branches, and only because the host was read completely and
         * showed nothing claiming them.
         */
        await tx.delete(containers).where(unclaimed(deployment.stackId));
      }

      if (deployment.actionId) {
        await tx
          .update(actions)
          .set({
            status: applied ? 'succeeded' : 'failed',
            completedAt: now,
            ...(applied ? {} : { errorCode: FAILURE_CODE[outcome.kind] }),
          })
          .where(eq(actions.id, deployment.actionId));
      }
    });

    await this.audit.record({
      action: AUDIT[outcome.kind],
      result: applied ? 'success' : 'failure',
      actorLabel: 'system',
      targetType: 'stack',
      targetId: deployment.stackId,
      targetLabel: deployment.name,
      reasonCode: deployment.id,
    });

    this.logger.info(
      {
        event: 'stack_apply_recovered',
        hostId,
        stackId: deployment.stackId,
        deploymentId: deployment.id,
        outcome: outcome.kind,
      },
      'an unfinished stack revision was settled from the host',
    );

    return true;
  }

  /**
   * The services a revision describes.
   *
   * From its stored summary, which carries names and nothing else — so
   * recovering an attempt never decrypts a Compose file or an environment.
   */
  private async services(revisionId: string): Promise<readonly string[]> {
    const [revision] = await this.db.client
      .select({ summary: stackRevisions.summary })
      .from(stackRevisions)
      .where(eq(stackRevisions.id, revisionId));

    return revision?.summary ? [...revision.summary.services] : [];
  }
}

interface Unfinished {
  readonly id: string;
  readonly stackId: string;
  readonly revisionId: string;
  readonly fromRevisionId: string | null;
  readonly actionId: string | null;
  readonly name: string;
}

interface UnfinishedOperation {
  readonly id: string;
  readonly stackId: string;
  readonly revisionId: string;
  readonly type: StackLifecycleKind;
  readonly fingerprint: typeof stackOperations.$inferSelect.fingerprint;
  readonly actionId: string | null;
  readonly name: string;
}

/** What each outcome of an operation is recorded as. */
const OPERATION_STATUS = {
  applied: 'succeeded',
  not_applied: 'failed',
  needs_attention: 'needs_attention',
  unknown: 'interrupted',
} as const;

/** The same codes the live path records, so one vocabulary describes both. */
const OPERATION_FAILED: Record<StackLifecycleKind, string> = {
  start: 'STACK_START_FAILED',
  stop: 'STACK_STOP_FAILED',
  restart: 'STACK_RESTART_FAILED',
};

/** What the stack is once an operation is known to have done what it said. */
const RUNTIME_STATUS: Record<StackLifecycleKind, string> = {
  start: 'running',
  stop: 'stopped',
  restart: 'running',
};

const OPERATION_AUDIT = {
  start: 'stack.started',
  stop: 'stack.stopped',
  restart: 'stack.restarted',
} as const;

const OPERATION_AUDIT_FAILED = {
  start: 'stack.start.failed',
  stop: 'stack.stop.failed',
  restart: 'stack.restart.failed',
} as const;

/** Resources of this stack that no container on the host claims. */
function unclaimed(stackId: string) {
  return and(eq(containers.stackId, stackId), isNull(containers.dockerId));
}

/** What each outcome is recorded as. */
const STATUS = {
  finalize_target: 'succeeded',
  finalize_from: 'rolled_back',
  finalize_not_applied: 'failed',
  needs_attention: 'needs_attention',
  unknown: 'interrupted',
} as const;

const FAILURE_CODE = {
  finalize_target: null,
  finalize_from: 'STACK_APPLY_FAILED',
  finalize_not_applied: 'STACK_APPLY_FAILED',
  needs_attention: 'STACK_DEPLOYMENT_PARTIAL',
  unknown: null,
} as const;

const AUDIT = {
  finalize_target: 'stack.deploy.succeeded',
  finalize_from: 'stack.apply.rolled_back',
  finalize_not_applied: 'stack.deploy.failed',
  needs_attention: 'stack.deploy.needs_attention',
  unknown: 'stack.deploy.interrupted',
} as const;
