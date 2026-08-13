import { and, desc, eq } from 'drizzle-orm';

import { AuditService } from '../src/audit/audit.service';
import { RecoveryFinalizer } from '../src/containers/recovery-finalizer';
import { RecoveryDecision } from '../src/containers/recovery';
import { SecretBox } from '../src/common/crypto';
import { Database } from '../src/database/database';
import {
  actions,
  auditEntries,
  containerDesiredConfigs,
  containerEnvironmentVariables,
  containers,
  hosts,
} from '../src/database/schema';
import { createLogger } from '../src/logging/logger';
import { prepareDatabase } from './database';

/**
 * Writing down what an interrupted mutation meant.
 *
 * The decision is made by a pure function and tested on its own. What is tested
 * here is the other half: that applying one lands in the database exactly once,
 * that a second pass over the same mutation changes nothing, and that two
 * passes arriving together produce one outcome rather than two.
 *
 * Nothing here waits on an agent or a host. That is the design being checked as
 * much as the behaviour: the transaction covers the database and nothing else.
 */
describe('finalising an interrupted mutation', () => {
  let db: Database;
  let box: SecretBox;
  let finalizer: RecoveryFinalizer;
  let hostId: string;

  beforeAll(async () => {
    db = await prepareDatabase();
    box = new SecretBox(Buffer.alloc(32, 7).toString('base64'));

    const logger = createLogger('silent');
    finalizer = new RecoveryFinalizer(db, new AuditService(db, logger), logger);

    const [host] = await db.client
      .insert(hosts)
      .values({ hostname: `recovery-${Date.now()}`, observedAt: new Date() })
      .returning({ id: hosts.id });

    hostId = host.id;
  });

  afterAll(async () => {
    await db.client.delete(hosts).where(eq(hosts.id, hostId));
    await db.onModuleDestroy();
  });

  /** A container mid-replacement: current A, candidate B, and a running action. */
  const interrupted = async (options: { operation: 'create' | 'replace' | 'remove' }) => {
    const name = `svc-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

    const [container] = await db.client
      .insert(containers)
      .values({
        hostId,
        dockerId: options.operation === 'create' ? null : `docker-${name}`,
        name,
        image: 'nginx:1.27',
        state: options.operation === 'create' ? 'creating' : 'running',
        observedAt: new Date(),
      })
      .returning({ id: containers.id, name: containers.name });

    const [action] = await db.client
      .insert(actions)
      .values({
        actorKind: 'user',
        capability: `container.${options.operation}`,
        targetType: 'container',
        targetId: container.id,
        hostId,
        status: 'running',
        correlationId: `correlation-${name}`,
      })
      .returning({ id: actions.id });

    const current =
      options.operation === 'create'
        ? null
        : (
            await db.client
              .insert(containerDesiredConfigs)
              .values({ containerId: container.id, state: 'current', image: 'nginx:1.27' })
              .returning({ id: containerDesiredConfigs.id })
          )[0].id;

    const pending =
      options.operation === 'remove'
        ? null
        : (
            await db.client
              .insert(containerDesiredConfigs)
              .values({
                containerId: container.id,
                state: 'pending',
                image: 'nginx:1.28',
                actionId: action.id,
              })
              .returning({ id: containerDesiredConfigs.id })
          )[0].id;

    return {
      context: {
        containerId: container.id,
        containerName: container.name,
        hostId,
        operation: options.operation,
        actionId: action.id,
      },
      current,
      pending,
    };
  };

  const configs = (containerId: string) =>
    db.client
      .select()
      .from(containerDesiredConfigs)
      .where(eq(containerDesiredConfigs.containerId, containerId));

  const action = async (actionId: string) => {
    const [row] = await db.client.select().from(actions).where(eq(actions.id, actionId));

    return row;
  };

  describe('promoting the candidate', () => {
    it('makes it what the container is, and retires the old one', async () => {
      const { context, current, pending } = await interrupted({ operation: 'replace' });

      const applied = await finalizer.finalize(context, {
        kind: 'promote_pending',
        desiredConfigId: pending!,
      });

      expect(applied).toBe(true);

      const rows = await configs(context.containerId);

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(pending);
      expect(rows[0].state).toBe('current');
      expect(rows[0].actionId).toBeNull();

      expect(rows.some((row) => row.id === current)).toBe(false);
    });

    it('takes the retired configuration’s secrets with it', async () => {
      const { context, current, pending } = await interrupted({ operation: 'replace' });

      await db.client.insert(containerEnvironmentVariables).values([
        {
          desiredConfigId: current!,
          key: 'DB_PASSWORD',
          valueEncrypted: box.encrypt('no-longer-running'),
          isSecret: true,
        },
        {
          desiredConfigId: pending!,
          key: 'DB_PASSWORD',
          valueEncrypted: box.encrypt('running'),
          isSecret: true,
        },
      ]);

      await finalizer.finalize(context, { kind: 'promote_pending', desiredConfigId: pending! });

      // A value that is not running anywhere has no reason to stay stored.
      expect(
        await db.client
          .select()
          .from(containerEnvironmentVariables)
          .where(eq(containerEnvironmentVariables.desiredConfigId, current!)),
      ).toHaveLength(0);

      const [survivor] = await db.client
        .select()
        .from(containerEnvironmentVariables)
        .where(eq(containerEnvironmentVariables.desiredConfigId, pending!));

      expect(box.decrypt(survivor.valueEncrypted!)).toBe('running');
    });

    it('closes the action the operator started', async () => {
      const { context, pending } = await interrupted({ operation: 'replace' });

      await finalizer.finalize(context, { kind: 'promote_pending', desiredConfigId: pending! });

      const row = await action(context.actionId);

      expect(row.status).toBe('succeeded');
      expect(row.completedAt).not.toBeNull();
      // The operation it was: one thing an operator started and the server
      // finished, not a second action attributed to nobody.
      expect(row.correlationId).toContain('correlation-');
    });
  });

  describe('discarding the candidate', () => {
    it('removes it and leaves the container as it was', async () => {
      const { context, current, pending } = await interrupted({ operation: 'replace' });

      const applied = await finalizer.finalize(context, {
        kind: 'discard_pending',
        desiredConfigId: pending!,
      });

      expect(applied).toBe(true);

      const rows = await configs(context.containerId);

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(current);
      expect(rows[0].state).toBe('current');

      expect((await action(context.actionId)).status).toBe('failed');
      expect((await action(context.actionId)).errorCode).toBe('REPLACEMENT_FAILED');
    });

    it('keeps the value that is actually running', async () => {
      const { context, current, pending } = await interrupted({ operation: 'replace' });

      await db.client.insert(containerEnvironmentVariables).values([
        {
          desiredConfigId: current!,
          key: 'DB_PASSWORD',
          valueEncrypted: box.encrypt('running'),
          isSecret: true,
        },
        {
          desiredConfigId: pending!,
          key: 'DB_PASSWORD',
          valueEncrypted: box.encrypt('never-applied'),
          isSecret: true,
        },
      ]);

      await finalizer.finalize(context, { kind: 'discard_pending', desiredConfigId: pending! });

      const [survivor] = await db.client
        .select()
        .from(containerEnvironmentVariables)
        .where(eq(containerEnvironmentVariables.desiredConfigId, current!));

      expect(box.decrypt(survivor.valueEncrypted!)).toBe('running');

      expect(
        await db.client
          .select()
          .from(containerEnvironmentVariables)
          .where(eq(containerEnvironmentVariables.desiredConfigId, pending!)),
      ).toHaveLength(0);
    });

    /*
     * A create that produced nothing leaves a resource that never became a
     * container. It goes entirely — which is also what releases the name it was
     * holding against a second create.
     */
    it('releases a create that never produced a container', async () => {
      const { context, pending } = await interrupted({ operation: 'create' });

      const applied = await finalizer.finalize(context, {
        kind: 'discard_pending',
        desiredConfigId: pending!,
      });

      expect(applied).toBe(true);

      expect(
        await db.client.select().from(containers).where(eq(containers.id, context.containerId)),
      ).toHaveLength(0);

      expect(await configs(context.containerId)).toHaveLength(0);
      expect((await action(context.actionId)).errorCode).toBe('CONTAINER_CREATE_FAILED');
    });

    it('leaves a create alone once a container has been observed for it', async () => {
      const { context, pending } = await interrupted({ operation: 'create' });

      // Discovery adopted the container between the decision and this call, so
      // the state that was classified is not the state in front of us.
      await db.client
        .update(containers)
        .set({ dockerId: 'observed-after-the-fact' })
        .where(eq(containers.id, context.containerId));

      const applied = await finalizer.finalize(context, {
        kind: 'discard_pending',
        desiredConfigId: pending!,
      });

      expect(applied).toBe(false);

      expect(
        await db.client.select().from(containers).where(eq(containers.id, context.containerId)),
      ).toHaveLength(1);

      // Still unresolved, so the next pass looks again.
      expect((await action(context.actionId)).status).toBe('running');
    });
  });

  describe('finishing a removal', () => {
    it('takes the resource, its configuration and its secrets', async () => {
      const { context, current } = await interrupted({ operation: 'remove' });

      await db.client.insert(containerEnvironmentVariables).values({
        desiredConfigId: current!,
        key: 'DB_PASSWORD',
        valueEncrypted: box.encrypt('gone with it'),
        isSecret: true,
      });

      const applied = await finalizer.finalize(context, { kind: 'finalize_remove' });

      expect(applied).toBe(true);

      expect(
        await db.client.select().from(containers).where(eq(containers.id, context.containerId)),
      ).toHaveLength(0);

      // A removal that left the secrets behind would not have removed much.
      expect(
        await db.client
          .select()
          .from(containerEnvironmentVariables)
          .where(eq(containerEnvironmentVariables.desiredConfigId, current!)),
      ).toHaveLength(0);

      expect((await action(context.actionId)).status).toBe('succeeded');
    });

    it('records a removal that did not happen as a failure, and removes nothing', async () => {
      const { context } = await interrupted({ operation: 'remove' });

      const applied = await finalizer.finalize(context, {
        kind: 'fail_operation',
        reason: 'the container was not removed',
      });

      expect(applied).toBe(true);

      expect(
        await db.client.select().from(containers).where(eq(containers.id, context.containerId)),
      ).toHaveLength(1);

      expect((await action(context.actionId)).status).toBe('failed');
      expect((await action(context.actionId)).errorCode).toBe('CONTAINER_REMOVE_FAILED');
    });
  });

  describe('a state that cannot be resolved', () => {
    it('marks the conflict and keeps the container blocked', async () => {
      const { context, pending } = await interrupted({ operation: 'replace' });

      const applied = await finalizer.finalize(
        { ...context, observedDockerIds: ['aaa111', 'bbb222'] },
        { kind: 'identity_conflict', reason: '2 containers claim this resource' },
      );

      expect(applied).toBe(true);

      const [row] = await db.client
        .select()
        .from(containers)
        .where(eq(containers.id, context.containerId));

      expect(row.identityConflict?.dockerIds).toEqual(['aaa111', 'bbb222']);

      // The candidate stays, so the guard keeps refusing operations until a
      // person settles which container is the real one.
      const rows = await configs(context.containerId);

      expect(rows.some((config) => config.id === pending)).toBe(true);
    });

    it('leaves the candidate in place when a person is needed', async () => {
      const { context, pending } = await interrupted({ operation: 'replace' });

      const applied = await finalizer.finalize(context, {
        kind: 'needs_attention',
        reason: 'the container carries no configuration identity',
      });

      expect(applied).toBe(true);

      const rows = await configs(context.containerId);

      expect(rows.some((config) => config.id === pending)).toBe(true);
      expect((await action(context.actionId)).errorCode).toBe('CONTAINER_STATE_UNRESOLVED');
    });

    it('does nothing at all when there is nothing to conclude', async () => {
      const { context, pending } = await interrupted({ operation: 'replace' });

      const applied = await finalizer.finalize(context, {
        kind: 'no_action',
        reason: 'the last discovery did not complete',
      });

      expect(applied).toBe(false);
      expect((await action(context.actionId)).status).toBe('running');
      expect(await configs(context.containerId)).toHaveLength(2);
      expect(pending).not.toBeNull();
    });
  });

  describe('two passes over the same mutation', () => {
    it('finalises it once, however many times it is asked', async () => {
      const { context, pending } = await interrupted({ operation: 'replace' });

      const decision: RecoveryDecision = { kind: 'promote_pending', desiredConfigId: pending! };

      expect(await finalizer.finalize(context, decision)).toBe(true);
      expect(await finalizer.finalize(context, decision)).toBe(false);
      expect(await finalizer.finalize(context, decision)).toBe(false);

      const rows = await configs(context.containerId);

      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('current');
    });

    /*
     * Two reconciliation passes reaching one unfinished mutation together.
     *
     * They agree about what happened, so both would write the same thing — and
     * writing it twice would mean two audit entries for one recovery and, for a
     * promotion, a second attempt against a row that is no longer pending.
     * Whoever claims the action does the work.
     */
    it('lets exactly one of two concurrent passes do the work', async () => {
      const { context, pending } = await interrupted({ operation: 'replace' });

      const decision: RecoveryDecision = { kind: 'promote_pending', desiredConfigId: pending! };

      const outcomes = await Promise.all([
        finalizer.finalize(context, decision),
        finalizer.finalize(context, decision),
      ]);

      expect(outcomes.filter(Boolean)).toHaveLength(1);

      const rows = await configs(context.containerId);

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(pending);
    });

    /*
     * A decision that no longer describes the container it was made about.
     *
     * Promotion deletes the old configuration before making the candidate
     * current, so noticing halfway that the candidate is not a candidate any
     * more means something has already been removed. The transaction goes back
     * with it: a container left with no configuration at all would be worse
     * than one whose recovery has not run yet.
     */
    it('puts back what it had already done when the state moved underneath it', async () => {
      const { context, current, pending } = await interrupted({ operation: 'replace' });

      // Something else promoted it: the old configuration is gone and the
      // candidate is now what the container is.
      await db.client
        .delete(containerDesiredConfigs)
        .where(eq(containerDesiredConfigs.id, current!));
      await db.client
        .update(containerDesiredConfigs)
        .set({ state: 'current' })
        .where(eq(containerDesiredConfigs.id, pending!));

      const applied = await finalizer.finalize(context, {
        kind: 'promote_pending',
        desiredConfigId: pending!,
      });

      expect(applied).toBe(false);

      // The configuration is still there. Without the rollback this call would
      // have deleted it on its way to promoting it.
      const rows = await configs(context.containerId);

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(pending);
      expect(rows[0].state).toBe('current');

      expect((await action(context.actionId)).status).toBe('running');
    });

    it('audits the recovery once, against the action it finished', async () => {
      const { context, pending } = await interrupted({ operation: 'replace' });

      const decision: RecoveryDecision = { kind: 'discard_pending', desiredConfigId: pending! };

      await Promise.all([
        finalizer.finalize(context, decision),
        finalizer.finalize(context, decision),
      ]);

      const entries = await db.client
        .select()
        .from(auditEntries)
        .where(
          and(
            eq(auditEntries.targetId, context.containerId),
            eq(auditEntries.action, 'container.recovery.discarded'),
          ),
        )
        .orderBy(desc(auditEntries.occurredAt));

      expect(entries).toHaveLength(1);
      expect(entries[0].actorLabel).toBe('container-recovery');
      expect(entries[0].actorUserId).toBeNull();
      // Correlated with the operation it closed rather than standing alone.
      expect(entries[0].reasonCode).toBe(context.actionId);
    });
  });
});
