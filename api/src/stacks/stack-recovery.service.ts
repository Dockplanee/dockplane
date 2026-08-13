import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Logger } from 'pino';

import { AuditService } from '../audit/audit.service';
import { LOGGER } from '../config/tokens';
import { Database } from '../database/database';
import { actions, agents, containers, stackDeployments, stacks } from '../database/schema';
import { DiscoveryService } from '../discovery/discovery.service';
import { MutationRegistry } from '../operations/mutation-registry';
import { classifyStackDeployment } from './stack-deployment';
import { UNRESOLVED_DEPLOYMENT, stackKey } from './stack-deployment.service';

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

    if (unfinished.length === 0) {
      return 0;
    }

    if (!(await this.readCompletely(hostId))) {
      this.logger.info(
        { event: 'stack_recovery_deferred', hostId, unresolved: unfinished.length },
        'unfinished stack deployments were left as they are: the host could not be read completely',
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
      })
      .from(containers)
      .where(eq(containers.stackId, deployment.stackId));

    const services = rows.map((row) => ({
      serviceName: row.stackService ?? '',
      containerId: row.id,
      dockerId: row.dockerId,
      state: row.dockerId ? row.state : null,
    }));

    // The host was read completely just above, which is the only reason
    // anything may be concluded here at all.
    const outcome = classifyStackDeployment({ services, snapshotComplete: true });

    if (outcome.kind === 'unknown') {
      return false;
    }

    const now = new Date();
    const detail = {
      services: services.map((service) => ({
        serviceName: service.serviceName,
        containerId: service.containerId,
        ...(service.state ? { state: service.state } : {}),
      })),
    };

    await this.db.client.transaction(async (tx) => {
      await tx
        .update(stackDeployments)
        .set({
          status: outcome.kind,
          detail,
          // An attempt waiting for a person is not resolved, so it keeps no
          // resolution time and goes on blocking the stack.
          resolvedAt: outcome.kind === 'needs_attention' ? null : now,
          ...(outcome.kind === 'succeeded' ? {} : { failureCode: FAILURE_CODE[outcome.kind] }),
          updatedAt: now,
        })
        .where(eq(stackDeployments.id, deployment.id));

      if (outcome.kind === 'succeeded') {
        /*
         * Compared against what the stack still is. Another pass, or the
         * request that started this, may have settled it first — and writing
         * over that would record the older of two answers.
         */
        await tx
          .update(stacks)
          .set({
            currentRevisionId: deployment.revisionId,
            desiredRevisionId: null,
            status: 'running',
            lastDeployedAt: now,
            updatedAt: now,
          })
          .where(and(eq(stacks.id, deployment.stackId), isNull(stacks.currentRevisionId)));
      } else {
        await tx
          .update(stacks)
          .set({
            status: outcome.kind === 'failed' ? 'not_deployed' : 'needs_attention',
            desiredRevisionId: null,
            updatedAt: now,
          })
          .where(eq(stacks.id, deployment.stackId));
      }

      if (outcome.kind === 'failed') {
        /*
         * Nothing was created, so the resources allocated for this attempt name
         * containers that do not exist. Removed only in this branch, and only
         * because the host was read completely and showed nothing claiming
         * them.
         */
        await tx.delete(containers).where(unclaimed(deployment.stackId));
      }

      if (deployment.actionId) {
        await tx
          .update(actions)
          .set({
            status: outcome.kind === 'succeeded' ? 'succeeded' : 'failed',
            completedAt: now,
            ...(outcome.kind === 'succeeded' ? {} : { errorCode: FAILURE_CODE[outcome.kind] }),
          })
          .where(eq(actions.id, deployment.actionId));
      }
    });

    await this.audit.record({
      action: outcome.kind === 'succeeded' ? 'stack.deploy.succeeded' : AUDIT[outcome.kind],
      result: outcome.kind === 'succeeded' ? 'success' : 'failure',
      actorLabel: 'system',
      targetType: 'stack',
      targetId: deployment.stackId,
      targetLabel: deployment.name,
      reasonCode: deployment.id,
    });

    this.logger.info(
      {
        event: 'stack_deployment_recovered',
        hostId,
        stackId: deployment.stackId,
        deploymentId: deployment.id,
        outcome: outcome.kind,
      },
      'an unfinished stack deployment was settled from the host',
    );

    return true;
  }
}

interface Unfinished {
  readonly id: string;
  readonly stackId: string;
  readonly revisionId: string;
  readonly actionId: string | null;
  readonly name: string;
}

/** Resources of this stack that no container on the host claims. */
function unclaimed(stackId: string) {
  return and(eq(containers.stackId, stackId), isNull(containers.dockerId));
}

const FAILURE_CODE = {
  failed: 'STACK_DEPLOYMENT_FAILED',
  needs_attention: 'STACK_DEPLOYMENT_PARTIAL',
} as const;

const AUDIT = {
  failed: 'stack.deploy.failed',
  needs_attention: 'stack.deploy.needs_attention',
} as const;
