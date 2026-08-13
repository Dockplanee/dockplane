import { and, eq } from 'drizzle-orm';

import { SecretBox } from '../src/common/crypto';
import { Database } from '../src/database/database';
import {
  containerDesiredConfigs,
  containerEnvironmentVariables,
  containers,
  hosts,
} from '../src/database/schema';
import { prepareDatabase } from './database';

/**
 * Current and pending configuration.
 *
 * Replacing a container is a Docker side effect and no database transaction can
 * roll one back, so the configuration a container is being asked to become is
 * written before the agent is asked for anything and becomes current only once
 * a container running it has been observed.
 *
 * That is only useful if the two can be told apart afterwards, and observed
 * state cannot do it: a replacement may change nothing but a secret, and
 * observed state deliberately holds no environment values. The container
 * carries the identity of the configuration it represents instead.
 */
describe('desired configuration', () => {
  let db: Database;
  let box: SecretBox;
  let hostId: string;

  beforeAll(async () => {
    db = await prepareDatabase();
    box = new SecretBox(Buffer.alloc(32, 11).toString('base64'));

    const [host] = await db.client
      .insert(hosts)
      .values({ hostname: `desired-${Date.now()}`, observedAt: new Date() })
      .returning({ id: hosts.id });
    hostId = host.id;
  });

  afterAll(async () => {
    await db.client.delete(hosts).where(eq(hosts.id, hostId));
    await db.onModuleDestroy();
  });

  async function createContainer(name: string): Promise<string> {
    const [row] = await db.client
      .insert(containers)
      .values({
        hostId,
        dockerId: `docker-${name}-${Date.now()}`,
        name,
        image: 'nginx:1.27',
        state: 'running',
        observedAt: new Date(),
      })
      .returning({ id: containers.id });

    return row.id;
  }

  async function addConfig(containerId: string, state: 'current' | 'pending', image = 'nginx:1.27') {
    const [row] = await db.client
      .insert(containerDesiredConfigs)
      .values({ containerId, state, image })
      .returning({ id: containerDesiredConfigs.id });

    return row.id;
  }

  it('gives every configuration an identity of its own', async () => {
    const containerId = await createContainer(`identity-${Date.now()}`);
    const current = await addConfig(containerId, 'current');
    const pending = await addConfig(containerId, 'pending');

    expect(current).not.toBe(pending);
    expect(current).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('lets a container be what it is and what it is becoming, at once', async () => {
    const containerId = await createContainer(`both-${Date.now()}`);
    await addConfig(containerId, 'current', 'nginx:1.27');
    await addConfig(containerId, 'pending', 'nginx:1.28');

    const rows = await db.client
      .select()
      .from(containerDesiredConfigs)
      .where(eq(containerDesiredConfigs.containerId, containerId));

    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.state === 'current')).toHaveLength(1);
    expect(rows.filter((row) => row.state === 'pending')).toHaveLength(1);
  });

  describe('what the database refuses', () => {
    it('refuses a second current configuration', async () => {
      const containerId = await createContainer(`two-current-${Date.now()}`);
      await addConfig(containerId, 'current');

      await expect(addConfig(containerId, 'current')).rejects.toThrow();
    });

    it('refuses a second pending configuration', async () => {
      const containerId = await createContainer(`two-pending-${Date.now()}`);
      await addConfig(containerId, 'pending');

      await expect(addConfig(containerId, 'pending')).rejects.toThrow();
    });

    it('refuses a state that is neither', async () => {
      const containerId = await createContainer(`bad-state-${Date.now()}`);

      await expect(
        db.client.insert(containerDesiredConfigs).values({
          containerId,
          state: 'applied' as 'current',
          image: 'nginx:1.27',
        }),
      ).rejects.toThrow();
    });

    it('refuses environment that belongs to no configuration', async () => {
      await expect(
        db.client.insert(containerEnvironmentVariables).values({
          desiredConfigId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
          key: 'A',
          value: '1',
          isSecret: false,
        }),
      ).rejects.toThrow();
    });
  });

  /*
   * The case the configuration identity exists for.
   *
   * Two configurations that differ only in a secret. Nothing observable
   * distinguishes them, and nothing observable has to.
   */
  describe('a replacement that changes only a secret', () => {
    it('keeps each value with the configuration it belongs to', async () => {
      const containerId = await createContainer(`secret-only-${Date.now()}`);
      const current = await addConfig(containerId, 'current');
      const pending = await addConfig(containerId, 'pending');

      await db.client.insert(containerEnvironmentVariables).values([
        { desiredConfigId: current, key: 'DB_PASSWORD', valueEncrypted: box.encrypt('secret-A'), isSecret: true },
        { desiredConfigId: pending, key: 'DB_PASSWORD', valueEncrypted: box.encrypt('secret-B'), isSecret: true },
      ]);

      const [running] = await db.client
        .select()
        .from(containerEnvironmentVariables)
        .where(eq(containerEnvironmentVariables.desiredConfigId, current));

      const [candidate] = await db.client
        .select()
        .from(containerEnvironmentVariables)
        .where(eq(containerEnvironmentVariables.desiredConfigId, pending));

      expect(box.decrypt(running.valueEncrypted!)).toBe('secret-A');
      expect(box.decrypt(candidate.valueEncrypted!)).toBe('secret-B');
    });

    it('leaves the running value alone when the candidate is discarded', async () => {
      const containerId = await createContainer(`rollback-${Date.now()}`);
      const current = await addConfig(containerId, 'current');
      const pending = await addConfig(containerId, 'pending');

      await db.client.insert(containerEnvironmentVariables).values([
        { desiredConfigId: current, key: 'DB_PASSWORD', valueEncrypted: box.encrypt('secret-A'), isSecret: true },
        { desiredConfigId: pending, key: 'DB_PASSWORD', valueEncrypted: box.encrypt('secret-B'), isSecret: true },
      ]);

      // What a failed replacement does: the candidate goes, nothing else moves.
      await db.client
        .delete(containerDesiredConfigs)
        .where(eq(containerDesiredConfigs.id, pending));

      const remaining = await db.client
        .select()
        .from(containerDesiredConfigs)
        .where(eq(containerDesiredConfigs.containerId, containerId));

      expect(remaining).toHaveLength(1);
      expect(remaining[0].state).toBe('current');

      const [value] = await db.client
        .select()
        .from(containerEnvironmentVariables)
        .where(eq(containerEnvironmentVariables.desiredConfigId, current));

      expect(box.decrypt(value.valueEncrypted!)).toBe('secret-A');

      // And the candidate's secret went with it.
      expect(
        await db.client
          .select()
          .from(containerEnvironmentVariables)
          .where(eq(containerEnvironmentVariables.desiredConfigId, pending)),
      ).toHaveLength(0);
    });

    it('promotes the candidate without touching its values', async () => {
      const containerId = await createContainer(`promote-${Date.now()}`);
      const current = await addConfig(containerId, 'current');
      const pending = await addConfig(containerId, 'pending');

      await db.client.insert(containerEnvironmentVariables).values([
        { desiredConfigId: current, key: 'DB_PASSWORD', valueEncrypted: box.encrypt('secret-A'), isSecret: true },
        { desiredConfigId: pending, key: 'DB_PASSWORD', valueEncrypted: box.encrypt('secret-B'), isSecret: true },
      ]);

      const [before] = await db.client
        .select()
        .from(containerEnvironmentVariables)
        .where(eq(containerEnvironmentVariables.desiredConfigId, pending));

      // What a successful replacement does: the old one goes, then the
      // candidate takes its place. In that order, because both may not be
      // current at once.
      await db.client.delete(containerDesiredConfigs).where(eq(containerDesiredConfigs.id, current));
      await db.client
        .update(containerDesiredConfigs)
        .set({ state: 'current' })
        .where(eq(containerDesiredConfigs.id, pending));

      const rows = await db.client
        .select()
        .from(containerDesiredConfigs)
        .where(eq(containerDesiredConfigs.containerId, containerId));

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(pending);
      expect(rows[0].state).toBe('current');

      const [after] = await db.client
        .select()
        .from(containerEnvironmentVariables)
        .where(eq(containerEnvironmentVariables.desiredConfigId, pending));

      // The envelope is the one that was written, byte for byte.
      expect(after.valueEncrypted).toBe(before.valueEncrypted);
      expect(box.decrypt(after.valueEncrypted!)).toBe('secret-B');
    });
  });

  it('still refuses a secret written in the clear', async () => {
    const containerId = await createContainer(`constraint-${Date.now()}`);
    const config = await addConfig(containerId, 'current');

    await expect(
      db.client.insert(containerEnvironmentVariables).values({
        desiredConfigId: config,
        key: 'DB_PASSWORD',
        value: 'written into the wrong column',
        isSecret: true,
      }),
    ).rejects.toThrow();
  });

  it('takes both configurations with the container', async () => {
    const containerId = await createContainer(`cascade-${Date.now()}`);
    const current = await addConfig(containerId, 'current');
    const pending = await addConfig(containerId, 'pending');

    await db.client
      .insert(containerEnvironmentVariables)
      .values({ desiredConfigId: pending, key: 'A', value: '1', isSecret: false });

    await db.client.delete(containers).where(eq(containers.id, containerId));

    expect(
      await db.client
        .select()
        .from(containerDesiredConfigs)
        .where(eq(containerDesiredConfigs.containerId, containerId)),
    ).toHaveLength(0);

    expect(
      await db.client
        .select()
        .from(containerEnvironmentVariables)
        .where(eq(containerEnvironmentVariables.desiredConfigId, current)),
    ).toHaveLength(0);
  });

  it('lets a pending configuration name the mutation that owns it', async () => {
    const containerId = await createContainer(`owner-${Date.now()}`);

    const [row] = await db.client
      .insert(containerDesiredConfigs)
      .values({ containerId, state: 'pending', image: 'nginx:1.27' })
      .returning({ id: containerDesiredConfigs.id, actionId: containerDesiredConfigs.actionId });

    expect(row.actionId).toBeNull();

    const [found] = await db.client
      .select()
      .from(containerDesiredConfigs)
      .where(
        and(
          eq(containerDesiredConfigs.containerId, containerId),
          eq(containerDesiredConfigs.state, 'pending'),
        ),
      );

    expect(found.id).toBe(row.id);
  });
});
