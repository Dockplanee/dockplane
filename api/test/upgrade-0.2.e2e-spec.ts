import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { TEST_DATABASE_URL } from './database';

/**
 * Upgrading a real 0.2.0 installation to this build.
 *
 * The first v0.3 migration adds a column to the hosts table, and the thing that
 * could go wrong is not the column: it is what a migration might be tempted to
 * infer while adding it. Several enrolments of one machine look like
 * duplicates, an offline host looks finished and a revoked agent looks retired
 * — and archiving any of them because of how they look would take hosts out of
 * an operator's working set that nobody chose to remove.
 *
 * So the basis is the schema 0.2.0 actually shipped, read out of that tag, and
 * filled with the shape that release is known to produce: six host identities
 * sharing system hostnames, with their containers and Compose projects.
 */
const RELEASE = 'v0.2.0';
const REPOSITORY = join(__dirname, '..', '..');
const MIGRATIONS = join('api', 'src', 'database', 'migrations');
const CURRENT = join(__dirname, '..', 'src', 'database', 'migrations');

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

/*
 * Six identities, three system hostnames, and the workloads attached to them.
 *
 * This is the shape a machine enrolled more than once leaves behind, and the
 * one that makes a hostname-based backfill look reasonable and be wrong.
 */
const SEED = `
  insert into hosts (id, hostname, display_name, os, docker_version, agent_version, last_seen_at, observed_at)
  values
    ('44444444-4444-4444-8444-000000000001', 'shared-01.example.test', 'Frankfurt 1', 'Debian GNU/Linux 13', '28.0.1', '0.2.0', '2026-08-12T18:00:00Z', '2026-08-12T18:00:00Z'),
    ('44444444-4444-4444-8444-000000000002', 'shared-01.example.test', 'Frankfurt 1 (re-enrolled)', 'Debian GNU/Linux 13', '28.0.1', '0.2.0', '2026-08-14T18:00:00Z', '2026-08-14T18:00:00Z'),
    ('44444444-4444-4444-8444-000000000003', 'shared-02.example.test', 'Berlin 1', 'Ubuntu 24.04.1 LTS', '27.3.1', '0.1.0', '2026-06-02T18:00:00Z', '2026-06-02T18:00:00Z'),
    ('44444444-4444-4444-8444-000000000004', 'shared-02.example.test', 'Berlin 1 (rebuilt)', 'Ubuntu 24.04.1 LTS', '28.0.1', '0.2.0', '2026-08-14T18:10:00Z', '2026-08-14T18:10:00Z'),
    ('44444444-4444-4444-8444-000000000005', 'lone-03.example.test', null, 'Debian GNU/Linux 13', '28.0.1', '0.2.0', '2026-08-14T18:20:00Z', '2026-08-14T18:20:00Z'),
    ('44444444-4444-4444-8444-000000000006', 'gone-04.example.test', 'Decommissioned', 'Debian GNU/Linux 12', '25.0.0', '0.1.0', '2026-01-04T09:00:00Z', '2026-01-04T09:00:00Z');
  insert into agents (id, host_id, certificate_fingerprint, certificate_serial, certificate_not_after, version, protocol_version, capabilities, status, first_seen_at, last_seen_at, revoked_at, revocation_reason)
  values
    ('55555555-5555-4555-8555-000000000001', '44444444-4444-4444-8444-000000000001', 'sha256:agent-1', '01', '2027-02-01T00:00:00Z', '0.2.0', 1, '[]'::jsonb, 'revoked', '2026-02-01T10:00:00Z', '2026-08-12T18:00:00Z', '2026-08-13T09:00:00Z', 'Replaced by a new enrolment'),
    ('55555555-5555-4555-8555-000000000002', '44444444-4444-4444-8444-000000000002', 'sha256:agent-2', '02', '2027-02-01T00:00:00Z', '0.2.0', 1, '[]'::jsonb, 'connected', '2026-08-13T10:00:00Z', '2026-08-14T18:00:00Z', null, null),
    ('55555555-5555-4555-8555-000000000006', '44444444-4444-4444-8444-000000000006', 'sha256:agent-6', '06', '2026-06-01T00:00:00Z', '0.1.0', 1, '[]'::jsonb, 'disconnected', '2026-01-04T09:00:00Z', '2026-01-04T09:00:00Z', null, null);
  insert into compose_projects (id, host_id, project_name, working_dir, status, service_count, running_count, services, observed_at)
  values
    ('66666666-6666-4666-8666-000000000001', '44444444-4444-4444-8444-000000000001', 'shop', '/srv/shop', 'running', 2, 2, '["web","db"]'::jsonb, '2026-08-12T18:00:00Z'),
    ('66666666-6666-4666-8666-000000000002', '44444444-4444-4444-8444-000000000006', 'legacy', '/srv/legacy', 'stopped', 1, 0, '["api"]'::jsonb, '2026-01-04T09:00:00Z');
  insert into containers (id, host_id, docker_id, name, image, state, health, restart_count, compose_project_id, observed_at)
  values
    ('77777777-7777-4777-8777-000000000001', '44444444-4444-4444-8444-000000000001', 'aaaaaaaaaaaa', 'shop-web-1', 'nginx:1.27-alpine', 'running', 'healthy', 0, '66666666-6666-4666-8666-000000000001', '2026-08-12T18:00:00Z'),
    ('77777777-7777-4777-8777-000000000002', '44444444-4444-4444-8444-000000000002', 'aaaaaaaaaaaa', 'shop-web-1', 'nginx:1.27-alpine', 'running', 'healthy', 0, null, '2026-08-14T18:00:00Z'),
    ('77777777-7777-4777-8777-000000000003', '44444444-4444-4444-8444-000000000006', 'bbbbbbbbbbbb', 'legacy-api-1', 'nginx:1.25', 'exited', 'none', 4, '66666666-6666-4666-8666-000000000002', '2026-01-04T09:00:00Z');
`;

describe('upgrading a 0.2.0 installation', () => {
  const database = `dockplane_upgrade_02_${process.pid}`;
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

  const one = async (query: ReturnType<typeof sql>): Promise<Record<string, unknown>> =>
    (await rows(query))[0];

  beforeAll(async () => {
    const admin = new Pool({ connectionString: server.toString() });

    await admin.query(`drop database if exists "${database}"`);
    await admin.query(`create database "${database}"`);
    await admin.end();

    directory = mkdtempSync(join(tmpdir(), 'dockplane-0.2.0-schema-'));
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
  }, 120_000);

  afterAll(async () => {
    await pool?.end();

    const admin = new Pool({ connectionString: server.toString() });

    await admin.query(`drop database if exists "${database}"`);
    await admin.end();

    rmSync(directory, { recursive: true, force: true });
  }, 60_000);

  it('starts from the schema 0.2.0 shipped, without the new column', async () => {
    expect(release[release.length - 1].tag).toBe('0015_stack_operations');

    const column = await rows(
      sql`select column_name from information_schema.columns
          where table_name = 'hosts' and column_name = 'archived_at'`,
    );

    expect(column).toHaveLength(0);
  });

  it('applies exactly the migrations this build added', async () => {
    const added = current.slice(release.length).map((entry) => entry.tag);

    expect(added).toEqual(['0016_host_archive']);

    await migrate(db, { migrationsFolder: CURRENT });

    const applied = await one(sql`select count(*)::int as total from drizzle.__drizzle_migrations`);

    expect(applied.total).toBe(current.length);
  }, 60_000);

  it('adds the column as nullable, with an index', async () => {
    const column = await one(
      sql`select is_nullable, column_default from information_schema.columns
          where table_name = 'hosts' and column_name = 'archived_at'`,
    );

    expect(column.is_nullable).toBe('YES');
    expect(column.column_default).toBeNull();

    const index = await rows(
      sql`select indexname from pg_indexes where tablename = 'hosts' and indexname = 'hosts_archived_idx'`,
    );

    expect(index).toHaveLength(1);
  });

  /*
   * The whole point of the migration being additive. Every one of these hosts
   * has a reason somebody might have written a backfill for — a shared
   * hostname, a revoked agent, months of silence — and none of them is a
   * decision the migration is entitled to make.
   */
  it('leaves every existing host active', async () => {
    const hosts = await rows(sql`select id, hostname, archived_at from hosts order by id`);

    expect(hosts).toHaveLength(6);
    expect(hosts.every((host) => host.archived_at === null)).toBe(true);
  });

  it('keeps the six identities distinct, hostnames and all', async () => {
    const hosts = await rows(sql`select hostname from hosts`);
    const hostnames = hosts.map((host) => host.hostname);

    expect(hostnames).toHaveLength(6);
    expect(new Set(hostnames).size).toBe(4);

    const shared = await one(
      sql`select count(*)::int as total from hosts where hostname = 'shared-01.example.test'`,
    );

    expect(shared.total).toBe(2);
  });

  it('keeps every workload and its attribution', async () => {
    const containers = await one(sql`select count(*)::int as total from containers`);
    const projects = await one(sql`select count(*)::int as total from compose_projects`);
    const agents = await one(sql`select count(*)::int as total from agents`);

    expect(containers.total).toBe(3);
    expect(projects.total).toBe(2);
    expect(agents.total).toBe(3);

    const orphaned = await one(
      sql`select count(*)::int as total from containers c
          left join hosts h on h.id = c.host_id where h.id is null`,
    );

    expect(orphaned.total).toBe(0);
  });

  /*
   * Two enrolments of one machine each carrying a container with the same
   * Docker identifier. The migration must not treat that as a duplicate.
   */
  it('keeps one Docker identifier on two identities as two records', async () => {
    const duplicated = await rows(
      sql`select host_id from containers where docker_id = 'aaaaaaaaaaaa' order by host_id`,
    );

    expect(duplicated).toHaveLength(2);
    expect(new Set(duplicated.map((row) => row.host_id)).size).toBe(2);
  });

  it('changes nothing about the agents', async () => {
    const revoked = await one(
      sql`select status, revoked_at, certificate_fingerprint from agents
          where id = '55555555-5555-4555-8555-000000000001'`,
    );

    expect(revoked.status).toBe('revoked');
    expect(revoked.revoked_at).not.toBeNull();
    expect(revoked.certificate_fingerprint).toBe('sha256:agent-1');
  });

  /* Applying the migrator again finds nothing to do. */
  it('is settled once it has run', async () => {
    const before = await one(sql`select count(*)::int as total from drizzle.__drizzle_migrations`);

    await migrate(db, { migrationsFolder: CURRENT });

    const after = await one(sql`select count(*)::int as total from drizzle.__drizzle_migrations`);

    expect(after.total).toBe(before.total);

    const hosts = await one(sql`select count(*)::int as total from hosts where archived_at is null`);

    expect(hosts.total).toBe(6);
  }, 60_000);
});
