import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { eq } from 'drizzle-orm';

import { Database } from '../src/database/database';
import { auditEntries, roles, userRoles, users } from '../src/database/schema';
import { verifyPassword } from '../src/common/crypto';
import { TEST_DATABASE_URL, prepareDatabase, resetData } from './database';

const run = promisify(execFile);
const script = join(__dirname, '..', 'src', 'cli', 'bootstrap-admin.ts');
const PASSWORD = 'a-long-development-passphrase';

/**
 * The bootstrap command is exercised as a real process, because its guarantees
 * come from the command itself: no account exists until it runs, and it refuses
 * to create a second administrator.
 */
async function bootstrap(email: string, password = PASSWORD) {
  try {
    const { stdout } = await run(
      process.execPath,
      ['--import', 'tsx', script, email, 'Test Administrator'],
      {
        env: {
          ...process.env,
          DATABASE_URL: TEST_DATABASE_URL,
          DOCKPLANE_BOOTSTRAP_PASSWORD: password,
        },
      },
    );

    return { ok: true as const, output: stdout };
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string };
    return { ok: false as const, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('administrator bootstrap', () => {
  let db: Database;

  beforeAll(async () => {
    db = await prepareDatabase();
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  beforeEach(async () => {
    await resetData(db);
  });

  it('ships without any account', async () => {
    const rows = await db.client.select().from(users);

    expect(rows).toHaveLength(0);
  });

  it('creates the first administrator', async () => {
    const result = await bootstrap('first@example.internal');

    expect(result.ok).toBe(true);

    const [user] = await db.client
      .select()
      .from(users)
      .where(eq(users.email, 'first@example.internal'));

    expect(user).toBeDefined();
    expect(await verifyPassword(user.passwordHash, PASSWORD)).toBe(true);
  });

  it('assigns the Administrator role', async () => {
    await bootstrap('roled@example.internal');

    const [assignment] = await db.client
      .select({ role: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(eq(users.email, 'roled@example.internal'));

    expect(assignment.role).toBe('Administrator');
  });

  it('never writes the password in clear', async () => {
    const result = await bootstrap('secret@example.internal');

    const [user] = await db.client
      .select()
      .from(users)
      .where(eq(users.email, 'secret@example.internal'));

    expect(result.output).not.toContain(PASSWORD);
    expect(user.passwordHash).not.toContain(PASSWORD);
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('records the bootstrap in the audit log without the password', async () => {
    await bootstrap('audited@example.internal');

    const [entry] = await db.client
      .select()
      .from(auditEntries)
      .where(eq(auditEntries.action, 'user.bootstrapped'));

    expect(entry.result).toBe('success');
    expect(entry.targetLabel).toBe('audited@example.internal');
    expect(JSON.stringify(entry)).not.toContain(PASSWORD);
  });

  it('refuses to create a second administrator', async () => {
    await bootstrap('one@example.internal');
    const second = await bootstrap('two@example.internal');

    expect(second.ok).toBe(false);
    expect(second.output).toContain('already exists');

    const rows = await db.client.select().from(users);
    expect(rows).toHaveLength(1);
  });

  it('refuses a password below the minimum length', async () => {
    const result = await bootstrap('short@example.internal', 'short');

    expect(result.ok).toBe(false);
    expect(result.output).toContain('at least');

    const rows = await db.client.select().from(users);
    expect(rows).toHaveLength(0);
  });

  it('creates exactly one administrator under concurrent attempts', async () => {
    const attempts = await Promise.all([
      bootstrap('race-a@example.internal'),
      bootstrap('race-b@example.internal'),
      bootstrap('race-c@example.internal'),
    ]);

    expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(1);

    const rows = await db.client.select().from(users);
    expect(rows).toHaveLength(1);
  });
});
