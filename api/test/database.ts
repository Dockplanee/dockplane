import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { Database } from '../src/database/database';
import { seedAuthorizationCatalog } from '../src/database/seed';

/**
 * Integration-test database.
 *
 * Security behaviour around sessions, enrollment and revocation depends on real
 * constraints and real transactions, so these tests run against PostgreSQL
 * rather than a mock. Set DATABASE_URL to point at a disposable database.
 */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://dockplane:dockplane@localhost:5433/dockplane';

let migrated = false;

export async function prepareDatabase(): Promise<Database> {
  if (!migrated) {
    const pool = new Pool({ connectionString: TEST_DATABASE_URL });
    const db = drizzle(pool);

    await migrate(db, { migrationsFolder: join(__dirname, '..', 'src', 'database', 'migrations') });
    await seedAuthorizationCatalog(db);
    await pool.end();

    migrated = true;
  }

  return new Database(TEST_DATABASE_URL);
}

/** Clears operational data while leaving the seeded authorization catalog intact. */
export async function resetData(db: Database): Promise<void> {
  await db.client.execute(sql`
    truncate table
      audit_entries,
      events,
      actions,
      containers,
      compose_projects,
      agents,
      hosts,
      agent_enrollment_tokens,
      recovery_codes,
      sessions,
      user_roles,
      users
    restart identity cascade
  `);
}
