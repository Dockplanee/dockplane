import { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';

import { Database } from '../src/database/database';
import { PROTOCOL_VERSION } from '../src/agents/protocol';
import { EXPECTED_SCHEMA_VERSION, readSchemaState } from '../src/version/schema-version';
import { createTestApp } from './app';

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
});
