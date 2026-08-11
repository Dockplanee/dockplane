/**
 * Applies pending migrations and seeds the authorization catalog.
 *
 * Schema changes are always explicit: nothing in the application synchronises a
 * schema at runtime, so a deployment that forgets this step fails visibly on
 * first query rather than silently rewriting production tables.
 */
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { resolveSecretFiles } from '../config/configuration';
import { seedAuthorizationCatalog } from '../database/seed';

// Beside the compiled code, so the same path holds when running from source
// and from a production image that carries no source tree.
const migrationsFolder = join(__dirname, '..', 'database', 'migrations');

async function main(): Promise<void> {
  const url = resolveSecretFiles(process.env).DATABASE_URL;

  if (!url) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  try {
    await migrate(db, { migrationsFolder });
    const summary = await seedAuthorizationCatalog(db);

    process.stdout.write(
      `migrations applied; permissions: ${summary.permissions}, roles: ${summary.roles}\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
