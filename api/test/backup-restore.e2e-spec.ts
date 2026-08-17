import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import request from 'supertest';

import { AgentGatewayService } from '../src/agents/agent-gateway.service';
import { SecretBox } from '../src/common/crypto';
import { Database } from '../src/database/database';
import { DiscoveryService } from '../src/discovery/discovery.service';
import { stackOperations, stackRevisionEnvironment } from '../src/database/schema';
import { TestAgentConnection } from './agent-client';
import { createAgentCsr } from './agent-pki';
import { TEST_DATABASE_URL } from './database';
import { STACK_ATTRIBUTION_MINIMUM_AGENT_VERSION } from '../src/stacks/stack-attribution';
import { FakeDockerHost } from './docker-host';
import {
  DEFAULT_PASSWORD,
  createTestApp,
  resetData,
  resetThrottling,
  seedUser,
  testPki,
} from './app';

const ORIGIN = 'http://localhost:4200';

/** In a stack secret. It has to come out of the restore as it went in. */
const CANARY = 'canary-restore-9f3a11b7';

/**
 * A backup taken and restored, with this version's data in it.
 *
 * Disaster recovery used to be checked by hand, which meant it was checked
 * before a release and not after every change. What is exercised here is the
 * dump format the backup command actually writes — PostgreSQL's own custom
 * format, produced by the same `pg_dump` invocation — restored into an empty
 * database that has never been migrated.
 *
 * The data this version added is what makes the restore worth testing again.
 * A stack's environment holds ciphertext that is worthless without a key kept
 * somewhere else, and an operation dispatched to a host and never answered is a
 * question about the world that a restore must carry over unanswered rather
 * than resolve on its own.
 */
describe('a backup of this version, restored', () => {
  let app: INestApplication;
  let db: Database;
  let discovery: DiscoveryService;
  let port: number;
  let caPem: string;
  let workspace: string;

  let host: FakeDockerHost;
  let connection: TestAgentConnection;
  let agentId: string;
  let hostId: string;
  let session: { cookie: string; csrf: string };
  let credentials: { certificatePem: string; privateKeyPem: string };

  /** Capabilities whose answer never comes back, leaving the outcome unknown. */
  let dropAfter = new Set<string>();

  const source = new URL(TEST_DATABASE_URL);
  const restored = new URL(TEST_DATABASE_URL);
  const server = new URL(TEST_DATABASE_URL);
  const target = `dockplane_restored_${process.pid}`;

  restored.pathname = `/${target}`;
  server.pathname = '/postgres';

  let pool: Pool;

  /**
   * A PostgreSQL client of the server's own version, reaching the database over
   * the network the way the backup command reaches it from outside its
   * container. Run in the image rather than from the host, because a client
   * older than the server refuses to dump at all.
   */
  const postgres = (command: string, args: string[], stdio: 'pipe' | 'inherit' = 'pipe') =>
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--add-host=host.docker.internal:host-gateway',
        '--volume',
        `${workspace}:/backup`,
        '--env',
        `PGPASSWORD=${decodeURIComponent(source.password)}`,
        'postgres:17.6-bookworm',
        command,
        '--host=host.docker.internal',
        `--port=${source.port}`,
        `--username=${source.username}`,
        ...args,
      ],
      { stdio: [stdio, stdio, 'pipe'], encoding: 'utf8' },
    );

  const signIn = async () => {
    const user = await seedUser(db, {
      email: `user-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.internal`,
      roleName: 'Administrator',
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('origin', ORIGIN)
      .send({ email: user.email, password: DEFAULT_PASSWORD });

    const raw = response.headers['set-cookie'] as unknown as string[];

    return {
      cookie: raw.find((entry) => entry.startsWith('dockplane_session='))!.split(';')[0],
      csrf: response.body.csrfToken as string,
    };
  };

  const openConnection = async () => {
    const opened = await TestAgentConnection.open({ port, caPem, ...credentials });

    opened.send({
      type: 'hello',
      protocolVersion: 1,
      agentVersion: STACK_ATTRIBUTION_MINIMUM_AGENT_VERSION,
    });
    await opened.waitFor('hello_ack');

    opened.onMessage((message) => {
      if (message.type !== 'request') {
        return;
      }

      const capability = String(message.capability);
      let response: Record<string, unknown>;

      try {
        response = {
          status: 'success',
          payload: host.handle(capability, (message.payload ?? {}) as Record<string, unknown>),
        };
      } catch (error) {
        response = { status: 'error', error: error as { code: string; message: string } };
      }

      // The host did the work and the answer went with the socket.
      if (dropAfter.has(capability)) {
        opened.close();
        return;
      }

      opened.send({
        type: 'response',
        protocolVersion: 1,
        id: message.id,
        capability: message.capability,
        ...response,
      });
    });

    return opened;
  };

  const connectAgent = async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/agents/enrollment-tokens')
      .set('cookie', session.cookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', session.csrf)
      .send({ intendedHostname: 'docker-01' });

    const { csrPem, privateKeyPem } = await createAgentCsr();

    const enrolled = await request(app.getHttpServer())
      .post('/api/v1/agent-enrollments')
      .send({ token: created.body.token, csr: csrPem, protocolVersion: 1, hostname: 'docker-01' });

    agentId = enrolled.body.agentId;
    credentials = { certificatePem: enrolled.body.certificate, privateKeyPem };

    return openConnection();
  };

  const api = (method: 'get' | 'post', path: string, body?: unknown) => {
    const agent = request(app.getHttpServer());
    const call = (method === 'get' ? agent.get(path) : agent.post(path))
      .set('cookie', session.cookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', session.csrf);

    return body === undefined ? call : call.send(body as object);
  };

  const COMPOSE = [
    'services:',
    '  web:',
    '    image: nginx:1.27',
    '    environment:',
    '      API_TOKEN: ${API_TOKEN}',
  ].join('\n');

  const rows = async (query: string): Promise<Record<string, unknown>[]> =>
    (await pool.query(query)).rows as Record<string, unknown>[];

  const count = async (table: string): Promise<number> =>
    Number((await rows(`select count(*)::int as total from ${table}`))[0].total);

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'dockplane-backup-'));

    execFileSync('go', ['build', '-o', join(workspace, 'compose-compiler'), '.'], {
      cwd: join(__dirname, '..', '..', 'compose-compiler'),
      stdio: 'pipe',
    });

    process.env.DOCKPLANE_COMPOSE_COMPILER = join(workspace, 'compose-compiler');

    app = await createTestApp();
    db = app.get(Database);
    discovery = app.get(DiscoveryService);
    port = app.get(AgentGatewayService).port;
    caPem = (await testPki()).caCertPem;

    await resetData(db);
    resetThrottling(app);

    host = new FakeDockerHost();
    session = await signIn();
    connection = await connectAgent();

    const sync = await discovery.sync(agentId);
    hostId = sync.hostId;

    // --- what a deployment of this version holds -----------------------------

    const created = await api('post', '/api/v1/stacks', {
      name: `shop${Date.now().toString(36)}`,
      hostId,
      compose: COMPOSE,
      environment: [{ operation: 'set-secret', key: 'API_TOKEN', value: CANARY }],
    });

    expect(created.status).toBe(201);

    const stackId = created.body.stackId as string;

    expect(
      (
        await api('post', `/api/v1/stacks/${stackId}/deploy`, {
          revisionId: created.body.revisionId,
        })
      ).status,
    ).toBe(200);

    // A second revision, saved and not deployed: work in progress is data too.
    const next = await api('post', `/api/v1/stacks/${stackId}/revisions`, {
      baseRevisionId: created.body.revisionId,
      compose: `${COMPOSE}\n      EXTRA: plain`,
      environment: [{ operation: 'unchanged', key: 'API_TOKEN' }],
    });

    expect(next.status).toBe(201);

    /*
     * And an operation whose answer never arrived. The state a restore must not
     * tidy up: nobody knows yet whether the host stopped this stack, and the
     * database is where that question is kept.
     */
    dropAfter = new Set(['stack.stop']);
    await api('post', `/api/v1/stacks/${stackId}/stop`);

    // --- the backup, and the restore ----------------------------------------

    postgres('pg_dump', [
      `--dbname=${source.pathname.slice(1)}`,
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--file=/backup/database.dump',
    ]);

    const admin = new Pool({ connectionString: server.toString() });

    await admin.query(`drop database if exists "${target}"`);
    await admin.query(`create database "${target}"`);
    await admin.end();

    // An empty database that has never been migrated: recovery does not get to
    // start from a schema somebody prepared for it.
    postgres('pg_restore', [
      `--dbname=${target}`,
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      '/backup/database.dump',
    ]);

    pool = new Pool({ connectionString: restored.toString() });
  }, 600_000);

  afterAll(async () => {
    connection?.close();
    await pool?.end();
    await app?.close();

    const admin = new Pool({ connectionString: server.toString() });

    await admin.query(`drop database if exists "${target}"`);
    await admin.end();

    rmSync(workspace, { recursive: true, force: true });
    delete process.env.DOCKPLANE_COMPOSE_COMPILER;
  }, 120_000);

  it('says what schema it is, so a restored database can be upgraded', async () => {
    const ledger = 'select hash, created_at from drizzle.__drizzle_migrations order by created_at';
    const applied = await rows(ledger);
    const here = await db.client.execute<{ hash: string; created_at: string }>(ledger);

    expect(applied).not.toHaveLength(0);
    expect(applied).toEqual(here.rows);
  });

  it('has the accounts, roles and permission catalog', async () => {
    expect(await count('users')).toBeGreaterThan(0);
    expect(await count('roles')).toBeGreaterThan(0);
    expect(await count('permissions')).toBeGreaterThan(0);
    expect(await count('user_roles')).toBeGreaterThan(0);
  });

  it('has the enrolled host and its agent', async () => {
    const [host] = await rows('select hostname from hosts');
    const [agent] = await rows('select certificate_fingerprint, status from agents');

    expect(host.hostname).toBe('docker-01');
    expect(agent.certificate_fingerprint).toEqual(expect.any(String));
  });

  it('has the stack, both of its revisions and what is deployed', async () => {
    const [stack] = await rows(
      'select name, status, current_revision_id, latest_revision_id from stacks',
    );
    const revisions = await rows('select number from stack_revisions order by number');

    expect(revisions.map((row) => row.number)).toEqual([1, 2]);
    expect(stack.current_revision_id).not.toBeNull();
    // Saved is ahead of deployed, and the restore keeps them apart.
    expect(stack.latest_revision_id).not.toEqual(stack.current_revision_id);
  });

  it('has the containers the stack put on the host', async () => {
    const containers = await rows(
      'select name, stack_service, stack_revision_id from containers where stack_id is not null',
    );

    expect(containers).toHaveLength(1);
    expect(containers[0].stack_service).toBe('web');
    expect(containers[0].stack_revision_id).toEqual(expect.any(String));
  });

  it('has the audit trail of how it got there', async () => {
    const entries = await rows("select action from audit_entries where action like 'stack.%'");

    expect(entries.length).toBeGreaterThan(0);
  });

  /*
   * The property the whole backup rests on. The ciphertext travels in the dump;
   * the key does not, and belongs to the deployment rather than to the database.
   */
  describe('a stack secret', () => {
    let ciphertext: string;

    beforeAll(async () => {
      const [row] = await rows(
        "select value_encrypted, value from stack_revision_environment where key = 'API_TOKEN' limit 1",
      );

      ciphertext = String(row.value_encrypted);

      expect(row.value).toBeNull();
    });

    it('is exactly the ciphertext that was written', async () => {
      const [original] = await db.client
        .select()
        .from(stackRevisionEnvironment)
        .where(eq(stackRevisionEnvironment.key, 'API_TOKEN'));

      expect(ciphertext).toBe(original.valueEncrypted);
      expect(ciphertext).not.toContain(CANARY);
    });

    it('reads back with the deployment’s key', () => {
      const box = new SecretBox(process.env.APPLICATION_ENCRYPTION_KEY!);

      expect(box.decrypt(ciphertext)).toBe(CANARY);
    });

    /*
     * A backup restored without its key is not a deployment somebody can log
     * into with a shrug. It fails, rather than producing something plausible.
     */
    it('does not read back with any other key', () => {
      const wrong = new SecretBox(Buffer.alloc(32, 9).toString('base64'));

      expect(() => wrong.decrypt(ciphertext)).toThrow();
    });
  });

  describe('an operation whose outcome was never known', () => {
    it('comes across still unresolved', async () => {
      const [operation] = await rows(
        "select type, status, resolved_at from stack_operations where type = 'stop'",
      );

      expect(operation.status).toBe('interrupted');
      expect(operation.resolved_at).toBeNull();
    });

    it('brings the fingerprint the answer will be judged against', async () => {
      const [original] = await db.client.select().from(stackOperations);
      const [copy] = await rows('select fingerprint from stack_operations');

      expect(copy.fingerprint).toEqual(original.fingerprint);
    });

    /*
     * And the index that keeps one stack to one unresolved operation came with
     * it. A restored database is only as safe as its constraints: without this
     * one, the first thing an operator did after a recovery could be to start a
     * second operation on a stack whose first is still in the air.
     */
    it('keeps the constraint that allows only one of them per stack', async () => {
      const [operation] = await rows(
        'select stack_id, revision_id, host_id from stack_operations limit 1',
      );

      await expect(
        pool.query(
          `insert into stack_operations (stack_id, revision_id, host_id, type, status)
           values ($1, $2, $3, 'start', 'pending')`,
          [operation.stack_id, operation.revision_id, operation.host_id],
        ),
      ).rejects.toThrow(/stack_operations_unresolved_unique/);
    });
  });
});
