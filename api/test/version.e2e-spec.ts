import { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';

import { Database } from '../src/database/database';
import { PROTOCOL_VERSION } from '../src/agents/protocol';
import { EXPECTED_SCHEMA_VERSION, readSchemaState } from '../src/version/schema-version';
import journal from '../src/database/migrations/meta/_journal.json';
import { createTestApp } from './app';

/** One ledger row per migration this build ships, and no others. */
const EXPECTED_MIGRATION_COUNT = journal.entries.length;

/*
What a deployment says about itself.

An operator upgrading a stack has to be able to ask which build answered and
whether its database has caught up. Both questions are asked before anyone
signs in, so the endpoint is unauthenticated — and it therefore has to be
careful to say nothing that is not already implied by the released artefacts.
*/
describe('the version endpoint', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports the build, the protocol and the schema', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/version').expect(200);

    expect(response.body).toEqual({
      version: expect.any(String),
      commit: expect.any(String),
      buildDate: expect.any(String),
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: EXPECTED_SCHEMA_VERSION,
      appliedSchemaVersion: EXPECTED_SCHEMA_VERSION,
    });
  });

  /*
   * The two schema values are the same on a current deployment and differ
   * during an upgrade. That difference is the whole point of reporting both.
   */
  it('distinguishes the schema this build expects from the one in the database', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/version').expect(200);

    expect(response.body.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
    expect(response.body.appliedSchemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
  });

  it('discloses no configuration', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/version').expect(200);

    const serialised = JSON.stringify(response.body).toLowerCase();

    for (const secret of ['postgres://', 'password', 'key', 'secret', 'token', 'path']) {
      expect(serialised).not.toContain(secret);
    }
  });

  /*
   * A build whose migrations have not been applied must be able to tell, so
   * that it can refuse to serve rather than fail later on the first request
   * that touches a column the database does not have.
   */
  it('notices when the database is behind the build', async () => {
    const db = app.get(Database);
    const before = await readSchemaState(db);

    expect(before.missing).toEqual([]);
    expect(before.applied).toBe(EXPECTED_SCHEMA_VERSION);

    /*
     * The ledger is what the migrator writes, and removing its last row is what
     * an upgrade looks like to a build that started too early.
     *
     * The row is kept so it can be put back exactly. A stand-in with a fresh
     * timestamp would restore the count without restoring the ledger, and the
     * migrator — which decides what to apply by timestamp, not by count —
     * would then try to run the last migration again against a schema that
     * already has it. That failure surfaces in whichever suite happens to
     * migrate next, which is nowhere near this test.
     */
    const [removed] = (
      await db.client.execute<{ hash: string; created_at: string }>(
        sql`delete from drizzle.__drizzle_migrations where id = (
          select id from drizzle.__drizzle_migrations order by created_at desc limit 1
        ) returning hash, created_at`,
      )
    ).rows;

    try {
      const behind = await readSchemaState(db);

      expect(behind.missing).toEqual([EXPECTED_SCHEMA_VERSION]);
      expect(behind.applied).not.toBe(EXPECTED_SCHEMA_VERSION);

      const response = await request(app.getHttpServer()).get('/api/v1/version').expect(200);

      expect(response.body.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
      expect(response.body.appliedSchemaVersion).not.toBe(EXPECTED_SCHEMA_VERSION);
    } finally {
      await db.client.execute(
        sql`insert into drizzle.__drizzle_migrations (hash, created_at)
          values (${removed.hash}, ${removed.created_at})`,
      );
    }

    // Back to what it was, so the next suite to migrate finds nothing to do.
    expect((await readSchemaState(db)).missing).toEqual([]);
  });

  /*
   * The ledger is shared state, and this suite is the only thing that writes to
   * it by hand.
   *
   * It once put back a stand-in row instead of the one it removed. The count
   * matched, so the version endpoint stayed happy and nothing here failed — but
   * the migrator picks what to apply by timestamp, and the next suite to
   * migrate tried to run a migration against a schema that already had it. The
   * failure surfaced in an unrelated test, several suites later.
   *
   * So the ledger is compared row for row, not counted.
   */
  it('leaves the migration ledger exactly as it found it', async () => {
    const db = app.get(Database);

    const ledger = async () => {
      const result = await db.client.execute<{ hash: string; created_at: string }>(
        sql`select hash, created_at from drizzle.__drizzle_migrations order by created_at, hash`,
      );

      return result.rows.map((row) => `${row.created_at}:${row.hash}`);
    };

    const before = await ledger();

    await request(app.getHttpServer()).get('/api/v1/version').expect(200);

    expect(await ledger()).toEqual(before);

    // And every row is one of this build's migrations, rather than something a
    // test wrote: a stand-in would pass a count check and fail this one.
    const hashes = new Set(before.map((entry) => entry.split(':')[1]));

    expect(hashes.size).toBe(before.length);
    expect(before).toHaveLength(EXPECTED_MIGRATION_COUNT);
  });
});
