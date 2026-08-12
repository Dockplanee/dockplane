import { eq } from 'drizzle-orm';

import { SecretBox } from '../src/common/crypto';
import { Database } from '../src/database/database';
import {
  agents,
  hosts,
  stackEnvironmentVariables,
  stackRevisions,
  stacks,
  users,
} from '../src/database/schema';
import { prepareDatabase } from './database';

/**
 * The properties the stack model exists to guarantee.
 *
 * A secret that reaches a plain column is a secret in a backup, in a database
 * copy and in anybody's `select *`. The application can be made to write the
 * wrong column by a mistake nobody notices; a constraint cannot, so the rule
 * lives in the database and these check that it does.
 *
 * A revision is the other half: a deployment names one, so what ran has to stay
 * exactly as it was written.
 */
describe('the stack model', () => {
  let db: Database;
  let box: SecretBox;
  let hostId: string;
  let userId: string;

  beforeAll(async () => {
    db = await prepareDatabase();
    box = new SecretBox(Buffer.alloc(32, 7).toString('base64'));

    const [user] = await db.client
      .insert(users)
      .values({
        email: `stack-model-${Date.now()}@dockplane.invalid`,
        passwordHash: 'x',
        displayName: 'Stack Model',
      })
      .returning({ id: users.id });
    userId = user.id;

    const [host] = await db.client
      .insert(hosts)
      .values({ hostname: `stack-model-${Date.now()}`, observedAt: new Date() })
      .returning({ id: hosts.id });
    hostId = host.id;
  });

  afterAll(async () => {
    await db.client.delete(hosts).where(eq(hosts.id, hostId));
    await db.client.delete(users).where(eq(users.id, userId));
    await db.onModuleDestroy();
  });

  async function createStack(name: string): Promise<string> {
    const [stack] = await db.client
      .insert(stacks)
      .values({ hostId, name, createdBy: userId })
      .returning({ id: stacks.id });

    return stack.id;
  }

  it('starts a stack as this deployment’s own, deployed to nothing', async () => {
    const id = await createStack(`own-${Date.now()}`);
    const [row] = await db.client.select().from(stacks).where(eq(stacks.id, id));

    expect(row.sourceType).toBe('dockplane');
    expect(row.status).toBe('unknown');
    expect(row.currentRevisionId).toBeNull();
    expect(row.lastDeployedAt).toBeNull();
    expect(row.adoptedAt).toBeNull();
  });

  it('refuses two stacks of the same name on one host', async () => {
    const name = `duplicate-${Date.now()}`;
    await createStack(name);

    await expect(createStack(name)).rejects.toThrow();
  });

  describe('a secret has one place to live', () => {
    it('stores a secret only as an envelope, never beside a plain value', async () => {
      const stackId = await createStack(`secret-${Date.now()}`);

      await db.client.insert(stackEnvironmentVariables).values({
        stackId,
        key: 'DB_PASSWORD',
        valueEncrypted: box.encrypt('correct horse battery staple'),
        isSecret: true,
      });

      const [row] = await db.client
        .select()
        .from(stackEnvironmentVariables)
        .where(eq(stackEnvironmentVariables.stackId, stackId));

      expect(row.value).toBeNull();
      expect(row.valueEncrypted).toMatch(/^v1\./);
      expect(row.valueEncrypted).not.toContain('correct horse');
      expect(box.decrypt(row.valueEncrypted!)).toBe('correct horse battery staple');
    });

    it('refuses a secret written in the clear', async () => {
      const stackId = await createStack(`plain-secret-${Date.now()}`);

      await expect(
        db.client.insert(stackEnvironmentVariables).values({
          stackId,
          key: 'DB_PASSWORD',
          value: 'written into the wrong column',
          isSecret: true,
        }),
      ).rejects.toThrow();
    });

    it('refuses a secret with no value at all', async () => {
      const stackId = await createStack(`empty-secret-${Date.now()}`);

      await expect(
        db.client
          .insert(stackEnvironmentVariables)
          .values({ stackId, key: 'DB_PASSWORD', isSecret: true }),
      ).rejects.toThrow();
    });

    it('refuses an ordinary variable that carries an envelope', async () => {
      const stackId = await createStack(`odd-plain-${Date.now()}`);

      await expect(
        db.client.insert(stackEnvironmentVariables).values({
          stackId,
          key: 'DB_NAME',
          valueEncrypted: box.encrypt('dockplane'),
          isSecret: false,
        }),
      ).rejects.toThrow();
    });

    it('refuses turning a secret into a plain one without clearing the envelope', async () => {
      const stackId = await createStack(`unmark-${Date.now()}`);

      await db.client.insert(stackEnvironmentVariables).values({
        stackId,
        key: 'API_TOKEN',
        valueEncrypted: box.encrypt('t0ken'),
        isSecret: true,
      });

      await expect(
        db.client
          .update(stackEnvironmentVariables)
          .set({ isSecret: false })
          .where(eq(stackEnvironmentVariables.stackId, stackId)),
      ).rejects.toThrow();
    });

    it('keeps an ordinary value readable', async () => {
      const stackId = await createStack(`ordinary-${Date.now()}`);

      await db.client
        .insert(stackEnvironmentVariables)
        .values({ stackId, key: 'DB_NAME', value: 'dockplane', isSecret: false });

      const [row] = await db.client
        .select()
        .from(stackEnvironmentVariables)
        .where(eq(stackEnvironmentVariables.stackId, stackId));

      expect(row.value).toBe('dockplane');
      expect(row.valueEncrypted).toBeNull();
    });

    it('holds one value per key per stack', async () => {
      const stackId = await createStack(`unique-key-${Date.now()}`);

      await db.client
        .insert(stackEnvironmentVariables)
        .values({ stackId, key: 'DB_NAME', value: 'first', isSecret: false });

      await expect(
        db.client
          .insert(stackEnvironmentVariables)
          .values({ stackId, key: 'DB_NAME', value: 'second', isSecret: false }),
      ).rejects.toThrow();
    });
  });

  describe('a revision is written once', () => {
    it('never stores the Compose source in the clear', async () => {
      const stackId = await createStack(`compose-${Date.now()}`);
      const source = 'services:\n  db:\n    image: postgres:17\n';

      await db.client.insert(stackRevisions).values({
        stackId,
        number: 1,
        composeSourceEncrypted: box.encrypt(source),
        environmentSnapshot: [],
        createdBy: userId,
      });

      const [row] = await db.client
        .select()
        .from(stackRevisions)
        .where(eq(stackRevisions.stackId, stackId));

      expect(row.composeSourceEncrypted).toMatch(/^v1\./);
      expect(row.composeSourceEncrypted).not.toContain('postgres');
      expect(box.decrypt(row.composeSourceEncrypted)).toBe(source);
    });

    it('numbers revisions once each per stack', async () => {
      const stackId = await createStack(`numbering-${Date.now()}`);

      const write = (number: number) =>
        db.client.insert(stackRevisions).values({
          stackId,
          number,
          composeSourceEncrypted: box.encrypt('services: {}'),
          environmentSnapshot: [],
        });

      await write(1);
      await write(2);
      await expect(write(2)).rejects.toThrow();
    });

    it('snapshots the environment so a rollback restores what the revision meant', async () => {
      const stackId = await createStack(`snapshot-${Date.now()}`);

      // Secrets are snapshotted the way they are stored: as envelopes.
      const snapshot = [
        { key: 'DB_NAME', value: 'dockplane', isSecret: false },
        { key: 'DB_PASSWORD', valueEncrypted: box.encrypt('s3cret'), isSecret: true },
      ];

      await db.client.insert(stackRevisions).values({
        stackId,
        number: 1,
        composeSourceEncrypted: box.encrypt('services: {}'),
        environmentSnapshot: snapshot,
      });

      const [row] = await db.client
        .select()
        .from(stackRevisions)
        .where(eq(stackRevisions.stackId, stackId));

      const stored = row.environmentSnapshot as typeof snapshot;

      expect(stored).toHaveLength(2);
      expect(JSON.stringify(stored)).not.toContain('s3cret');
      expect(box.decrypt(stored[1].valueEncrypted!)).toBe('s3cret');
    });

    it('goes with its stack', async () => {
      const stackId = await createStack(`cascade-${Date.now()}`);

      await db.client.insert(stackRevisions).values({
        stackId,
        number: 1,
        composeSourceEncrypted: box.encrypt('services: {}'),
        environmentSnapshot: [],
      });
      await db.client
        .insert(stackEnvironmentVariables)
        .values({ stackId, key: 'K', value: 'v', isSecret: false });

      await db.client.delete(stacks).where(eq(stacks.id, stackId));

      expect(
        await db.client.select().from(stackRevisions).where(eq(stackRevisions.stackId, stackId)),
      ).toHaveLength(0);
      expect(
        await db.client
          .select()
          .from(stackEnvironmentVariables)
          .where(eq(stackEnvironmentVariables.stackId, stackId)),
      ).toHaveLength(0);
    });
  });

  it('leaves discovered Compose projects alone', async () => {
    // Nothing in this migration turns a discovered project into a stack. A
    // project becomes one by being adopted, which is somebody's decision.
    const all = await db.client.select().from(stacks);
    const adopted = all.filter((stack) => stack.sourceType === 'adopted');

    expect(adopted).toHaveLength(0);
    expect(agents).toBeDefined();
  });
});
