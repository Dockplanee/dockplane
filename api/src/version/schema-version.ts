import { sql } from 'drizzle-orm';

import { Database } from '../database/database';
import journal from '../database/migrations/meta/_journal.json';

/**
 * Which schema this build expects, and which one the database is at.
 *
 * Two different questions, and an upgrade is exactly the moment they disagree.
 * The build's answer comes from the migration journal it ships; the database's
 * answer comes from the ledger the migrator writes. Comparing them is how a
 * control server can refuse to serve against a schema it does not understand,
 * instead of failing later on whichever query happens to touch a missing
 * column.
 */

/** The last migration this build contains. */
export const EXPECTED_SCHEMA_VERSION: string =
  journal.entries[journal.entries.length - 1]?.tag ?? 'none';

/** Every migration this build contains, in order. */
const EXPECTED_MIGRATIONS: readonly string[] = journal.entries.map((entry) => entry.tag);

export interface SchemaState {
  /** The last migration the database has applied, or null if none has. */
  readonly applied: string | null;
  /** Migrations this build expects that the database has not applied. */
  readonly missing: readonly string[];
}

/**
 * Reads the migrator's ledger.
 *
 * Drizzle records a hash and a timestamp per applied migration rather than the
 * tag, so the count is what identifies how far the database has come. That is
 * enough: migrations are applied in order and never removed.
 */
export async function readSchemaState(db: Database): Promise<SchemaState> {
  const result = await db.client.execute<{ count: string }>(
    sql`select count(*)::text as count from drizzle.__drizzle_migrations`,
  );

  const applied = Number(result.rows[0]?.count ?? 0);

  return {
    applied: applied > 0 ? (EXPECTED_MIGRATIONS[applied - 1] ?? 'unknown') : null,
    missing: EXPECTED_MIGRATIONS.slice(applied),
  };
}
