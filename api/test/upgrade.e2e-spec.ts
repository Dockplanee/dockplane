import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { PERMISSION_KEYS } from '../src/rbac/permissions';
import { seedAuthorizationCatalog } from '../src/database/seed';
import { TEST_DATABASE_URL } from './database';

/**
 * Upgrading a real 0.1.0 installation.
 *
 * The schema an operator upgrades from is the one that release shipped, not the
 * first few files of the current migration folder — those are only the same
 * until somebody edits one, and an upgrade test built by truncating the current
 * set would go on passing after that. So the 0.1.0 basis is read out of the
 * 0.1.0 tag, applied to an empty database, filled with the kind of data a year
 * of use leaves behind, and only then handed to this build's migrator.
 *
 * What is checked afterwards is what an operator would lose: their accounts,
 * their second factors, their hosts and the audit record of what was done.
 */
const RELEASE = 'v0.1.0';
const REPOSITORY = join(__dirname, '..', '..');
const MIGRATIONS = join('api', 'src', 'database', 'migrations');
const CURRENT = join(__dirname, '..', 'src', 'database', 'migrations');

/** The migration ledger drizzle keeps, and the only record of what was applied. */
const LEDGER = sql`drizzle.__drizzle_migrations`;

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
}

function fromRelease(path: string): string {
  try {
    return execFileSync('git', ['show', `${RELEASE}:${path}`], {
      cwd: REPOSITORY,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    throw new Error(
      `${RELEASE} is not in this checkout, so the upgrade path cannot be tested against ` +
        `the schema it shipped. Fetch the tags (git fetch --tags) and run this again.`,
    );
  }
}

/** The 0.1.0 migration folder, written out exactly as that release carried it. */
function releaseMigrations(directory: string): JournalEntry[] {
  const journal = fromRelease(join(MIGRATIONS, 'meta', '_journal.json'));
  const entries = (JSON.parse(journal) as { entries: JournalEntry[] }).entries;

  mkdirSync(join(directory, 'meta'), { recursive: true });
  writeFileSync(join(directory, 'meta', '_journal.json'), journal);

  for (const entry of entries) {
    writeFileSync(
      join(directory, `${entry.tag}.sql`),
      fromRelease(join(MIGRATIONS, `${entry.tag}.sql`)),
    );
  }

  return entries;
}

/**
 * What a 0.1.0 database holds after being used: accounts with second factors,
 * enrolled hosts, discovered workloads, and the audit trail of it happening.
 * Written as the SQL that release's columns allowed, so nothing here can
 * accidentally depend on a column this version added.
 */
const SEED = `
  insert into users (id, email, password_hash, display_name, mfa_enabled, mfa_secret_encrypted, mfa_confirmed_at, last_login_at)
  values
    ('11111111-1111-4111-8111-111111111111', 'admin@example.test', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', 'Release Manager', true, 'v1:2f8a:ciphertext-of-the-totp-secret', '2026-02-01T09:00:00Z', '2026-08-01T07:30:00Z'),
    ('22222222-2222-4222-8222-222222222222', 'operator@example.test', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$b3RoZXI', 'Duty Operator', false, null, null, '2026-07-30T22:15:00Z');
  insert into recovery_codes (user_id, code_hash, consumed_at)
  values
    ('11111111-1111-4111-8111-111111111111', 'sha256:unused-recovery-code', null),
    ('11111111-1111-4111-8111-111111111111', 'sha256:spent-recovery-code', '2026-05-04T11:00:00Z');
  insert into sessions (id, user_id, token_hash, csrf_token_hash, mfa_pending, source_ip, expires_at)
  values ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'sha256:session', 'sha256:csrf', false, '203.0.113.9', '2027-01-01T00:00:00Z');
  insert into hosts (id, hostname, display_name, os, architecture, docker_version, agent_version, last_seen_at, observed_at)
  values ('44444444-4444-4444-8444-444444444444', 'docker-01.example.test', 'Frankfurt 1', 'Ubuntu 24.04.1 LTS', 'x86_64', '27.3.1', '0.1.0', '2026-08-12T18:00:00Z', '2026-08-12T18:00:00Z');
  insert into agents (id, host_id, certificate_fingerprint, certificate_serial, certificate_not_after, version, protocol_version, capabilities, status, first_seen_at, last_seen_at)
  values ('55555555-5555-4555-8555-555555555555', '44444444-4444-4444-8444-444444444444', 'sha256:agent-certificate', '0f2c', '2027-02-01T00:00:00Z', '0.1.0', 1, '["host.inventory","container.list","container.restart"]'::jsonb, 'active', '2026-02-01T10:00:00Z', '2026-08-12T18:00:00Z');
  insert into compose_projects (id, host_id, project_name, working_dir, status, service_count, running_count, services, observed_at)
  values ('66666666-6666-4666-8666-666666666666', '44444444-4444-4444-8444-444444444444', 'shop', '/srv/shop', 'running', 2, 2, '["web","db"]'::jsonb, '2026-08-12T18:00:00Z');
  insert into containers (id, host_id, docker_id, name, image, state, health, restart_count, compose_project_id, detail, observed_at)
  values
    ('77777777-7777-4777-8777-777777777777', '44444444-4444-4444-8444-444444444444', 'a1b2c3d4e5f6', 'shop-web-1', 'nginx:1.27-alpine', 'running', 'healthy', 3, '66666666-6666-4666-8666-666666666666', '{"Config":{"Env":["REDACTED"]}}'::jsonb, '2026-08-12T18:00:00Z'),
    ('88888888-8888-4888-8888-888888888888', '44444444-4444-4444-8444-444444444444', 'f6e5d4c3b2a1', 'shop-db-1', 'postgres:17-alpine', 'running', 'none', 0, '66666666-6666-4666-8666-666666666666', null, '2026-08-12T18:00:00Z');
  insert into actions (id, actor_user_id, capability, target_type, target_id, host_id, status, completed_at, correlation_id)
  values ('99999999-9999-4999-8999-999999999999', '22222222-2222-4222-8222-222222222222', 'container.restart', 'container', 'a1b2c3d4e5f6', '44444444-4444-4444-8444-444444444444', 'succeeded', '2026-08-11T12:00:05Z', 'req-restart-1');
  insert into audit_entries (actor_user_id, actor_label, action, target_type, target_id, target_label, result, request_id)
  values ('22222222-2222-4222-8222-222222222222', 'operator@example.test', 'container.restart', 'container', 'a1b2c3d4e5f6', 'shop-web-1', 'success', 'req-restart-1');
  insert into events (host_id, type, severity, resource, message, correlation_id)
  values ('44444444-4444-4444-8444-444444444444', 'container.restarted', 'info', 'container/shop-web-1', 'Container restarted on request.', 'req-restart-1');
  insert into host_setups (id, display_name, created_by, ticket_hash, ticket_expires_at, agent_id, host_id, completed_at)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Frankfurt 1', '11111111-1111-4111-8111-111111111111', 'sha256:setup-ticket', '2026-02-01T11:00:00Z', '55555555-5555-4555-8555-555555555555', '44444444-4444-4444-8444-444444444444', '2026-02-01T10:05:00Z');
`;

/* A role somebody made themselves. Built-in roles are replaced by the seed on
 * every upgrade; this one is theirs, and an upgrade must leave it as it is. */
const CUSTOM_ROLE = `
  insert into roles (id, name, description, is_built_in)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Night Shift', 'Restarts and reads, out of hours.', false);
  insert into permissions (key, description)
  values ('containers.read', 'View discovered containers'), ('containers.restart', 'Restart a container');
  insert into role_permissions (role_id, permission_id)
  select 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', id from permissions where key in ('containers.read', 'containers.restart');
  insert into user_roles (user_id, role_id)
  values ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
`;

describe('upgrading a 0.1.0 installation', () => {
  const database = `dockplane_upgrade_${process.pid}`;
  const url = new URL(TEST_DATABASE_URL);
  const server = new URL(TEST_DATABASE_URL);

  url.pathname = `/${database}`;
  server.pathname = '/postgres';

  let directory: string;
  let pool: Pool;
  let db: NodePgDatabase<Record<string, never>>;
  let release: JournalEntry[];
  let current: JournalEntry[];

  const rows = async (query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
    (await db.execute(query)).rows as unknown as Record<string, unknown>[];

  const ledger = async (): Promise<{ hash: string; created_at: string }[]> =>
    (await rows(sql`select hash, created_at from ${LEDGER} order by created_at`)) as never;

  /* Timestamps as an instant rather than as whatever the driver formats. */
  const utc = (column: string) =>
    sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ${column}`);

  beforeAll(async () => {
    const admin = new Pool({ connectionString: server.toString() });

    // A database of its own: this one is dropped and rebuilt, and the shared
    // test database holds every other suite's data.
    await admin.query(`drop database if exists "${database}"`);
    await admin.query(`create database "${database}"`);
    await admin.end();

    directory = mkdtempSync(join(tmpdir(), 'dockplane-0.1.0-schema-'));
    release = releaseMigrations(directory);
    current = (
      JSON.parse(readFileSync(join(CURRENT, 'meta', '_journal.json'), 'utf8')) as {
        entries: JournalEntry[];
      }
    ).entries;

    pool = new Pool({ connectionString: url.toString() });
    db = drizzle(pool);

    await migrate(db, { migrationsFolder: directory });
    await pool.query(SEED);
    await pool.query(CUSTOM_ROLE);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();

    const admin = new Pool({ connectionString: server.toString() });

    await admin.query(`drop database if exists "${database}"`);
    await admin.end();

    rmSync(directory, { recursive: true, force: true });
  }, 60_000);

  it('starts from the schema 0.1.0 shipped', async () => {
    expect(release.map((entry) => entry.tag)).toEqual([
      '0000_initial_schema',
      '0001_agent_enrollment',
      '0002_discovery',
      '0003_inspect_detail',
      '0004_audit_action_index',
      '0005_host_setup',
    ]);

    expect(await ledger()).toHaveLength(release.length);

    /*
     * And this build still carries those files unchanged. drizzle decides what
     * to apply from the journal's timestamps, so an edited historical migration
     * is never re-run: the database keeps a hash of something that is no longer
     * what the repository says was applied, and every later upgrade is built on
     * a schema nobody can reconstruct.
     */
    for (const entry of release) {
      expect({
        tag: entry.tag,
        sql: readFileSync(join(CURRENT, `${entry.tag}.sql`), 'utf8'),
      }).toEqual({
        tag: entry.tag,
        sql: readFileSync(join(directory, `${entry.tag}.sql`), 'utf8'),
      });
    }

    expect(current.slice(0, release.length)).toEqual(release);

    // Nothing this version added is there yet, which is what makes the rest of
    // this suite an upgrade rather than a fresh install.
    const [{ present }] = await rows(
      sql`select count(*)::int as present from information_schema.tables where table_schema = 'public' and table_name = 'stacks'`,
    );

    expect(present).toBe(0);
  });

  describe('after this build has migrated it', () => {
    let before: { hash: string; created_at: string }[];

    beforeAll(async () => {
      before = await ledger();
      await migrate(db, { migrationsFolder: CURRENT });
      await seedAuthorizationCatalog(db);
    }, 120_000);

    it('applies every migration this build carries and no more', async () => {
      const applied = await ledger();

      expect(applied).toHaveLength(current.length);
      expect(current).toHaveLength(17);
    });

    /*
     * The 0.1.0 entries are still the ones 0.1.0 wrote. A migrator that
     * re-applied or rewrote them would produce a database that no longer says
     * truthfully what has been run against it.
     */
    it('leaves the entries 0.1.0 wrote untouched', async () => {
      const applied = await ledger();

      expect(applied.slice(0, before.length)).toEqual(before);
    });

    it('applies them in the order the journal declares', async () => {
      const applied = await ledger();
      const stamps = applied.map((entry) => Number(entry.created_at));

      expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
      expect(stamps).toEqual(current.map((entry) => entry.when));
    });

    it('has nothing left to do when it is run again', async () => {
      const applied = await ledger();

      await migrate(db, { migrationsFolder: CURRENT });

      expect(await ledger()).toEqual(applied);
    });

    it('keeps the accounts, including the encrypted second factor', async () => {
      const [admin] = await rows(
        sql`select email, display_name, mfa_enabled, mfa_secret_encrypted, ${utc('mfa_confirmed_at')} from users where email = 'admin@example.test'`,
      );

      expect(admin).toEqual({
        email: 'admin@example.test',
        display_name: 'Release Manager',
        mfa_enabled: true,
        // Byte for byte: the encryption key is unchanged by an upgrade, and a
        // migration that re-encrypted this would lock everyone out of their
        // second factor.
        mfa_secret_encrypted: 'v1:2f8a:ciphertext-of-the-totp-secret',
        mfa_confirmed_at: '2026-02-01T09:00:00Z',
      });
    });

    it('keeps recovery codes, spent and unspent', async () => {
      const codes = await rows(
        sql`select code_hash, ${utc('consumed_at')} from recovery_codes order by code_hash`,
      );

      expect(codes).toEqual([
        { code_hash: 'sha256:spent-recovery-code', consumed_at: '2026-05-04T11:00:00Z' },
        { code_hash: 'sha256:unused-recovery-code', consumed_at: null },
      ]);
    });

    it('keeps the session that was open', async () => {
      const [session] = await rows(sql`select token_hash, revoked_at from sessions`);

      expect(session).toEqual({ token_hash: 'sha256:session', revoked_at: null });
    });

    it('keeps the host and the agent enrolled against it', async () => {
      const [host] = await rows(sql`select hostname, agent_version from hosts`);
      const [agent] = await rows(
        sql`select certificate_fingerprint, protocol_version, status from agents`,
      );

      expect(host).toEqual({ hostname: 'docker-01.example.test', agent_version: '0.1.0' });
      expect(agent).toEqual({
        certificate_fingerprint: 'sha256:agent-certificate',
        protocol_version: 1,
        status: 'active',
      });
    });

    it('keeps discovered workloads, and claims none of them for a stack', async () => {
      const containers = await rows(
        sql`select name, docker_id, state, stack_id, stack_service, stack_revision_id from containers order by name`,
      );

      expect(containers).toEqual([
        {
          name: 'shop-db-1',
          docker_id: 'f6e5d4c3b2a1',
          state: 'running',
          stack_id: null,
          stack_service: null,
          stack_revision_id: null,
        },
        {
          name: 'shop-web-1',
          docker_id: 'a1b2c3d4e5f6',
          state: 'running',
          stack_id: null,
          stack_service: null,
          stack_revision_id: null,
        },
      ]);
    });

    it('keeps the audit trail and the actions it refers to', async () => {
      const [audit] = await rows(
        sql`select action, target_label, result, request_id from audit_entries`,
      );
      const [action] = await rows(sql`select capability, status, correlation_id from actions`);

      expect(audit).toEqual({
        action: 'container.restart',
        target_label: 'shop-web-1',
        result: 'success',
        request_id: 'req-restart-1',
      });
      expect(action).toEqual({
        capability: 'container.restart',
        status: 'succeeded',
        correlation_id: 'req-restart-1',
      });
    });

    it('keeps the completed host setup and the event history', async () => {
      const [setup] = await rows(sql`select display_name, ${utc('completed_at')} from host_setups`);
      const [event] = await rows(sql`select type, message from events`);

      expect(setup).toEqual({
        display_name: 'Frankfurt 1',
        completed_at: '2026-02-01T10:05:00Z',
      });
      expect(event).toEqual({
        type: 'container.restarted',
        message: 'Container restarted on request.',
      });
    });

    it('leaves a role somebody made themselves exactly as it was', async () => {
      const [role] = await rows(
        sql`select name, description, is_built_in from roles where name = 'Night Shift'`,
      );
      const granted = await rows(
        sql`select p.key from role_permissions rp join permissions p on p.id = rp.permission_id
            join roles r on r.id = rp.role_id where r.name = 'Night Shift' order by p.key`,
      );
      const members = await rows(
        sql`select u.email from user_roles ur join users u on u.id = ur.user_id
            join roles r on r.id = ur.role_id where r.name = 'Night Shift'`,
      );

      expect(role).toEqual({
        name: 'Night Shift',
        description: 'Restarts and reads, out of hours.',
        is_built_in: false,
      });
      expect(granted).toEqual([{ key: 'containers.read' }, { key: 'containers.restart' }]);
      expect(members).toEqual([{ email: 'operator@example.test' }]);
    });

    it('brings the permission catalog up to this version', async () => {
      const catalog = await rows(sql`select key from permissions order by key`);

      expect(catalog.map((entry) => entry.key)).toEqual([...PERMISSION_KEYS].sort());
    });

    /* Every new table exists and is empty: an upgrade adds capacity, not data. */
    it('adds this version’s tables without inventing anything to put in them', async () => {
      for (const table of [
        'stacks',
        'stack_revisions',
        'stack_revision_environment',
        'stack_deployments',
        'stack_operations',
        'container_desired_configs',
        'container_environment_variables',
      ]) {
        const [{ count }] = await rows(
          sql`select count(*)::int as count from ${sql.identifier(table)}`,
        );

        expect({ table, count }).toEqual({ table, count: 0 });
      }
    });

    /*
     * 0.1.0 required a Docker id on every container because every container it
     * knew about had been discovered. This version creates them, so a container
     * exists before Docker has given it one.
     */
    it('allows a container that Docker has not created yet', async () => {
      const [column] = await rows(
        sql`select is_nullable from information_schema.columns
            where table_name = 'containers' and column_name = 'docker_id'`,
      );

      expect(column).toEqual({ is_nullable: 'YES' });
    });
  });
});
