import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { SecretBox } from '../src/common/crypto';
import { SECRET_BOX } from '../src/config/tokens';
import { Database } from '../src/database/database';
import {
  auditEntries,
  composeProjects,
  hosts,
  stackRevisionEnvironment,
  stackRevisions,
  stacks,
} from '../src/database/schema';
import { DEFAULT_PASSWORD, createTestApp, resetData, resetThrottling, seedUser } from './app';
import { prepareDatabase } from './database';

const ORIGIN = 'http://localhost:4200';

/** In the environment: must never come back from anything. */
const ENV_CANARY = 'canary-stack-env-1c0ffee';
/** Written into the Compose file by hand: a different rule applies. */
const INLINE_CANARY = 'canary-stack-inline-2deadbeef';

/**
 * Saving stacks, and what saving one is allowed to leave behind.
 *
 * A stack here is a configuration and a history, not something running. Every
 * revision is compiled by the real compiler before it is stored, so what is
 * saved is deployable — and nothing is deployed, because nothing can be yet.
 *
 * The rules under scrutiny are about what the database holds and what the API
 * gives back. A Compose file is encrypted at rest because an author can write a
 * password straight into one. Secret variables are encrypted individually and
 * never returned. And an old revision does not change when a new one is saved,
 * because a revision that could change is not a record of anything.
 */
describe('saving stacks', () => {
  let app: INestApplication;
  let db: Database;
  let box: SecretBox;
  let workspace: string;
  let hostId: string;
  let session: { cookie: string; csrf: string };

  const api = (method: 'get' | 'post', path: string, body?: unknown) => {
    const agent = request(app.getHttpServer());
    const call = (method === 'get' ? agent.get(path) : agent.post(path))
      .set('cookie', session.cookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', session.csrf);

    return body === undefined ? call : call.send(body as object);
  };

  const signIn = async (roleName = 'Administrator') => {
    const user = await seedUser(db, {
      email: `user-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.internal`,
      roleName,
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

  const COMPOSE = [
    'services:',
    '  web:',
    '    image: nginx:1.27',
    '    environment:',
    '      DB_PASSWORD: ${DB_PASSWORD}',
    '      APP_ENV: ${APP_ENV}',
    'volumes:',
    '  app-data: {}',
  ].join('\n');

  /** One stack with a secret and an ordinary variable. */
  const createStack = async (overrides: Record<string, unknown> = {}) => {
    const response = await api('post', '/api/v1/stacks', {
      name: `shop-${Date.now().toString(36)}`,
      hostId,
      compose: COMPOSE,
      environment: [
        { operation: 'set-secret', key: 'DB_PASSWORD', value: ENV_CANARY },
        { operation: 'set', key: 'APP_ENV', value: 'production' },
      ],
      ...overrides,
    });

    return response;
  };

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'dockplane-stack-'));

    execFileSync('go', ['build', '-o', join(workspace, 'compose-compiler'), '.'], {
      cwd: join(__dirname, '..', '..', 'compose-compiler'),
      stdio: 'pipe',
    });

    process.env.DOCKPLANE_COMPOSE_COMPILER = join(workspace, 'compose-compiler');

    app = await createTestApp();
    db = app.get(Database);
    box = app.get(SECRET_BOX);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    rmSync(workspace, { recursive: true, force: true });
    delete process.env.DOCKPLANE_COMPOSE_COMPILER;
  });

  beforeEach(async () => {
    await resetData(db);
    resetThrottling(app);
    session = await signIn();

    const [host] = await db.client
      .insert(hosts)
      .values({ hostname: `docker-${Date.now()}`, observedAt: new Date() })
      .returning({ id: hosts.id });

    hostId = host.id;
  });

  describe('creating', () => {
    it('saves a stack, its first revision and what it would create', async () => {
      const response = await createStack();

      expect(response.status).toBe(201);
      expect(response.body.revisionNumber).toBe(1);
      expect(response.body.summary.services).toEqual(['web']);
      expect(response.body.summary.volumes).toEqual(['app-data']);

      const [stack] = await db.client.select().from(stacks);

      expect(stack.latestRevisionId).toBe(response.body.revisionId);
      // Nothing has run. Nothing claims otherwise.
      expect(stack.status).toBe('not_deployed');
      expect(stack.currentRevisionId).toBeNull();
      expect(stack.sourceType).toBe('dockplane');
    }, 120_000);

    it('refuses a configuration Dockplane could not deploy, and saves nothing', async () => {
      const response = await createStack({ compose: 'services:\n  app:\n    build: .\n' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('STACK_CONFIGURATION_INVALID');
      expect(response.body.details[0].path).toBe('services.app.build');

      // A saved revision that cannot be deployed is a problem discovered at the
      // worst moment, so there is no such thing.
      expect(await db.client.select().from(stacks)).toHaveLength(0);
      expect(await db.client.select().from(stackRevisions)).toHaveLength(0);
    }, 120_000);

    it('refuses a second stack of the same name on one host', async () => {
      const name = `shop-${Date.now().toString(36)}`;

      expect((await createStack({ name })).status).toBe(201);

      const second = await createStack({ name });

      expect(second.status).toBe(409);
      expect(second.body.code).toBe('STACK_NAME_CONFLICT');
    }, 120_000);

    it('allows the same name on another host', async () => {
      const name = `shop-${Date.now().toString(36)}`;

      expect((await createStack({ name })).status).toBe(201);

      const [elsewhere] = await db.client
        .insert(hosts)
        .values({ hostname: `docker-other-${Date.now()}`, observedAt: new Date() })
        .returning({ id: hosts.id });

      expect((await createStack({ name, hostId: elsewhere.id })).status).toBe(201);
    }, 120_000);

    /*
     * A Compose project already on the host is not Dockplane's to take over.
     * Creating a stack that would later deploy over one is refused here rather
     * than discovered during a deployment.
     */
    it('refuses a name a discovered Compose project already has', async () => {
      await db.client.insert(composeProjects).values({
        hostId,
        projectName: 'existing-project',
        status: 'running',
        observedAt: new Date(),
      });

      const response = await createStack({ name: 'existing-project' });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_NAME_CONFLICT');

      // And the discovered project stays exactly what it was.
      const [project] = await db.client.select().from(composeProjects);

      expect(project.projectName).toBe('existing-project');
    }, 120_000);

    it('refuses a host that does not exist', async () => {
      const response = await createStack({ hostId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' });

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('HOST_NOT_FOUND');
    }, 120_000);

    it('saves a stack for a host whose agent has never connected', async () => {
      // Preparing a stack for a machine that is offline is reasonable.
      // Deploying to one is not, and that is a different operation.
      expect((await createStack()).status).toBe(201);
    }, 120_000);
  });

  describe('what the database holds', () => {
    it('stores the Compose source encrypted, exactly as it was written', async () => {
      const source = `# a comment the author wrote\n${COMPOSE}\n`;

      await createStack({ compose: source });

      const [revision] = await db.client.select().from(stackRevisions);

      expect(revision.composeSourceEncrypted).not.toContain('services');
      expect(revision.composeSourceEncrypted.startsWith('v1.')).toBe(true);

      // Byte for byte, comment included: the author has to edit this again, and
      // the compiler's idea of their file is not their file.
      expect(box.decrypt(revision.composeSourceEncrypted)).toBe(source);
    }, 120_000);

    it('stores a secret encrypted and an ordinary value as itself', async () => {
      await createStack();

      const environment = await db.client.select().from(stackRevisionEnvironment);
      const secret = environment.find((row) => row.key === 'DB_PASSWORD')!;
      const plain = environment.find((row) => row.key === 'APP_ENV')!;

      expect(secret.isSecret).toBe(true);
      expect(secret.value).toBeNull();
      expect(box.decrypt(secret.valueEncrypted!)).toBe(ENV_CANARY);

      expect(plain.isSecret).toBe(false);
      expect(plain.value).toBe('production');
      expect(plain.valueEncrypted).toBeNull();
    }, 120_000);

    it('refuses a secret written into the column that holds plain values', async () => {
      await createStack();

      const [revision] = await db.client.select().from(stackRevisions);

      // The constraint is the database's, not a convention the code follows.
      await expect(
        db.client.insert(stackRevisionEnvironment).values({
          revisionId: revision.id,
          key: 'LEAKED',
          value: ENV_CANARY,
          isSecret: true,
        }),
      ).rejects.toThrow();
    }, 120_000);

    it('stores no plan, and no resolved environment', async () => {
      await createStack();

      const [revision] = await db.client.select().from(stackRevisions);

      // The plan carries resolved values. A deployment recompiles the source
      // rather than reading one back out of a database.
      expect(JSON.stringify(revision.summary)).not.toContain(ENV_CANARY);
      expect(Object.keys(revision)).not.toContain('plan');
      /*
       * Names and the order between them, and nothing else. The dependencies
       * are here because starting and stopping a deployed stack has to follow
       * them and deliberately does not compile the source to find them out.
       */
      expect(revision.summary).toEqual({
        services: ['web'],
        networks: ['default'],
        volumes: ['app-data'],
        dependsOn: {},
      });
    }, 120_000);

    /* A stack whose services wait for each other records which waits for which. */
    it('stores the order services depend on, by name', async () => {
      const response = await api('post', '/api/v1/stacks', {
        name: `shop-${Date.now().toString(36)}`,
        hostId,
        compose: [
          'services:',
          '  db:',
          '    image: postgres:17',
          '  web:',
          '    image: nginx:1.27',
          '    depends_on:',
          '      - db',
        ].join('\n'),
        environment: [],
      });

      expect(response.status).toBe(201);

      const [revision] = await db.client
        .select()
        .from(stackRevisions)
        .where(eq(stackRevisions.id, response.body.revisionId));

      expect(revision.summary?.dependsOn).toEqual({ web: ['db'] });
    }, 120_000);

    it('records which contract the revision was checked against', async () => {
      await createStack();

      const [revision] = await db.client.select().from(stackRevisions);

      expect(revision.compilerProtocolVersion).toBe(1);
      expect(revision.planVersion).toBe(1);
      expect(revision.validatedAt).not.toBeNull();
    }, 120_000);
  });

  describe('revisions', () => {
    const nextRevision = async (stackId: string, baseRevisionId: string, body: object) =>
      api('post', `/api/v1/stacks/${stackId}/revisions`, {
        baseRevisionId,
        compose: COMPOSE,
        ...body,
      });

    it('carries an untouched secret across without re-encrypting it', async () => {
      const created = await createStack();
      const before = await db.client.select().from(stackRevisionEnvironment);
      const secretBefore = before.find((row) => row.key === 'DB_PASSWORD')!;

      const second = await nextRevision(created.body.stackId, created.body.revisionId, {
        compose: COMPOSE.replace('nginx:1.27', 'nginx:1.28'),
        environment: [
          { operation: 'unchanged', key: 'DB_PASSWORD' },
          { operation: 'set', key: 'APP_ENV', value: 'production' },
        ],
      });

      expect(second.status).toBe(201);
      expect(second.body.revisionNumber).toBe(2);

      const after = await db.client
        .select()
        .from(stackRevisionEnvironment)
        .where(eq(stackRevisionEnvironment.revisionId, second.body.revisionId));

      const secretAfter = after.find((row) => row.key === 'DB_PASSWORD')!;

      // The same envelope, not a re-encryption. A new one would make two
      // revisions look different where nothing changed.
      expect(secretAfter.valueEncrypted).toBe(secretBefore.valueEncrypted);
    }, 120_000);

    it('gives a changed secret its own envelope and leaves the old one alone', async () => {
      const created = await createStack();
      const [firstRevision] = await db.client.select().from(stackRevisions);

      const second = await nextRevision(created.body.stackId, created.body.revisionId, {
        environment: [
          { operation: 'set-secret', key: 'DB_PASSWORD', value: 'a-different-secret' },
          { operation: 'set', key: 'APP_ENV', value: 'production' },
        ],
      });

      const older = await db.client
        .select()
        .from(stackRevisionEnvironment)
        .where(eq(stackRevisionEnvironment.revisionId, firstRevision.id));

      const newer = await db.client
        .select()
        .from(stackRevisionEnvironment)
        .where(eq(stackRevisionEnvironment.revisionId, second.body.revisionId));

      expect(box.decrypt(older.find((row) => row.key === 'DB_PASSWORD')!.valueEncrypted!)).toBe(
        ENV_CANARY,
      );
      expect(box.decrypt(newer.find((row) => row.key === 'DB_PASSWORD')!.valueEncrypted!)).toBe(
        'a-different-secret',
      );
    }, 120_000);

    it('drops a removed variable from the new revision only', async () => {
      const created = await createStack();
      const [firstRevision] = await db.client.select().from(stackRevisions);

      const second = await nextRevision(created.body.stackId, created.body.revisionId, {
        compose:
          'services:\n  web:\n    image: nginx:1.27\n    environment:\n      APP_ENV: ${APP_ENV}\n',
        environment: [
          { operation: 'remove', key: 'DB_PASSWORD' },
          { operation: 'set', key: 'APP_ENV', value: 'production' },
        ],
      });

      expect(second.status).toBe(201);

      const newer = await db.client
        .select()
        .from(stackRevisionEnvironment)
        .where(eq(stackRevisionEnvironment.revisionId, second.body.revisionId));

      expect(newer.map((row) => row.key)).toEqual(['APP_ENV']);

      // The revision it came from is untouched.
      const older = await db.client
        .select()
        .from(stackRevisionEnvironment)
        .where(eq(stackRevisionEnvironment.revisionId, firstRevision.id));

      expect(older.map((row) => row.key).sort()).toEqual(['APP_ENV', 'DB_PASSWORD']);
    }, 120_000);

    it('leaves an earlier revision exactly as it was', async () => {
      const created = await createStack();
      const [before] = await db.client.select().from(stackRevisions);

      await nextRevision(created.body.stackId, created.body.revisionId, {
        compose: COMPOSE.replace('nginx:1.27', 'nginx:1.28'),
        environment: [
          { operation: 'unchanged', key: 'DB_PASSWORD' },
          { operation: 'set', key: 'APP_ENV', value: 'staging' },
        ],
      });

      const [after] = await db.client
        .select()
        .from(stackRevisions)
        .where(eq(stackRevisions.id, before.id));

      expect(after).toEqual(before);
    }, 120_000);

    it('refuses a save based on a revision that is no longer the latest', async () => {
      const created = await createStack();

      await nextRevision(created.body.stackId, created.body.revisionId, {
        environment: [
          { operation: 'unchanged', key: 'DB_PASSWORD' },
          { operation: 'set', key: 'APP_ENV', value: 'production' },
        ],
      });

      // Somebody else saved in the meantime. This one is refused rather than
      // written over their work.
      const stale = await nextRevision(created.body.stackId, created.body.revisionId, {
        environment: [
          { operation: 'unchanged', key: 'DB_PASSWORD' },
          { operation: 'set', key: 'APP_ENV', value: 'staging' },
        ],
      });

      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('STACK_REVISION_CONFLICT');

      expect(await db.client.select().from(stackRevisions)).toHaveLength(2);
    }, 120_000);

    it('lets exactly one of two simultaneous saves through', async () => {
      const created = await createStack();

      const save = () =>
        nextRevision(created.body.stackId, created.body.revisionId, {
          environment: [
            { operation: 'unchanged', key: 'DB_PASSWORD' },
            { operation: 'set', key: 'APP_ENV', value: 'production' },
          ],
        }).then(
          (response) => response.status,
          () => 500,
        );

      const [first, second] = await Promise.all([save(), save()]);

      // One saved, one was told the stack had changed. Never two revision 2s,
      // and never an unhandled constraint violation.
      expect([first, second].filter((status) => status === 201)).toHaveLength(1);
      expect([first, second].filter((status) => status === 409)).toHaveLength(1);

      const numbers = (
        await db.client
          .select({ number: stackRevisions.number })
          .from(stackRevisions)
          .orderBy(desc(stackRevisions.number))
      ).map((row) => row.number);

      expect(numbers).toEqual([2, 1]);
    }, 120_000);

    it('refuses an invalid revision and leaves the latest pointer alone', async () => {
      const created = await createStack();

      const response = await nextRevision(created.body.stackId, created.body.revisionId, {
        compose: 'services:\n  app:\n    image: nginx\n    privileged: true\n',
        environment: [{ operation: 'unchanged', key: 'DB_PASSWORD' }],
      });

      expect(response.status).toBe(400);

      const [stack] = await db.client.select().from(stacks);

      expect(stack.latestRevisionId).toBe(created.body.revisionId);
      expect(await db.client.select().from(stackRevisions)).toHaveLength(1);
    }, 120_000);
  });

  describe('what the API gives back', () => {
    it('lists stacks without their source or their environment', async () => {
      const created = await createStack();
      const response = await api('get', '/api/v1/stacks');

      expect(response.status).toBe(200);

      const [stack] = response.body.stacks;

      expect(stack.id).toBe(created.body.stackId);
      expect(stack.status).toBe('not_deployed');
      expect(stack.deployedRevisionId).toBeNull();
      expect(stack.latestRevision.number).toBe(1);

      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain(ENV_CANARY);
      expect(serialised).not.toContain('services:');
    }, 120_000);

    it('lists revisions without their source or their values', async () => {
      const created = await createStack();
      const response = await api('get', `/api/v1/stacks/${created.body.stackId}/revisions`);

      expect(response.status).toBe(200);
      expect(response.body.revisions[0].number).toBe(1);
      expect(response.body.revisions[0].latest).toBe(true);
      expect(response.body.revisions[0].deployed).toBe(false);
      expect(JSON.stringify(response.body)).not.toContain(ENV_CANARY);
      expect(JSON.stringify(response.body)).not.toContain('services:');
    }, 120_000);

    it('returns the configuration to somebody who may edit it, without values', async () => {
      const created = await createStack();

      const response = await api(
        'get',
        `/api/v1/stacks/${created.body.stackId}/revisions/${created.body.revisionId}/configuration`,
      );

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.compose).toContain('image: nginx:1.27');

      const secret = response.body.environment.find(
        (entry: { key: string }) => entry.key === 'DB_PASSWORD',
      );

      // Reported as secret, carrying nothing else — not a value, not an
      // envelope, not a length.
      expect(secret).toEqual({ key: 'DB_PASSWORD', secret: true });

      expect(response.body.environment).toContainEqual({
        key: 'APP_ENV',
        secret: false,
        value: 'production',
      });

      expect(JSON.stringify(response.body)).not.toContain(ENV_CANARY);
    }, 120_000);

    /*
     * The one place a value can come back, and why.
     *
     * A password written straight into a Compose file is part of the file. The
     * file is encrypted at rest, but an authorized editor opening it sees what
     * they wrote — there is no way to hide it and still let them edit it. The
     * documentation says so, and this pins the behaviour.
     */
    it('returns an inline value in the source, because the source is the source', async () => {
      const inline = `services:\n  web:\n    image: nginx:1.27\n    environment:\n      LEGACY: ${INLINE_CANARY}\n`;

      const created = await api('post', '/api/v1/stacks', {
        name: `inline-${Date.now().toString(36)}`,
        hostId,
        compose: inline,
        environment: [],
      });

      expect(created.status).toBe(201);

      const [revision] = await db.client.select().from(stackRevisions);

      // In the database it is only ever an envelope.
      expect(revision.composeSourceEncrypted).not.toContain(INLINE_CANARY);

      const listing = await api('get', '/api/v1/stacks');

      expect(JSON.stringify(listing.body)).not.toContain(INLINE_CANARY);

      const configuration = await api(
        'get',
        `/api/v1/stacks/${created.body.stackId}/revisions/${created.body.revisionId}/configuration`,
      );

      expect(configuration.body.compose).toContain(INLINE_CANARY);
    }, 120_000);
  });

  describe('who may do what', () => {
    it('refuses an unauthenticated caller', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/stacks')
        .set('origin', ORIGIN)
        .send({ name: 'shop', hostId, compose: 'services: {}', environment: [] });

      expect(response.status).toBe(401);
    }, 60_000);

    it('refuses a request without the token that proves it was intended', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/stacks')
        .set('cookie', session.cookie)
        .set('origin', ORIGIN)
        .send({ name: 'shop', hostId, compose: 'services: {}', environment: [] });

      expect(response.status).toBe(403);
    }, 60_000);

    /*
     * Looking at stacks and reading one's Compose source are different things.
     * The source can contain a credential its author wrote into it, so it sits
     * behind the permission to change a stack rather than the one to see it.
     */
    it('lets a viewer list stacks and not read a configuration', async () => {
      const created = await createStack();
      const administrator = session;
      const configuration = `/api/v1/stacks/${created.body.stackId}/revisions/${created.body.revisionId}/configuration`;

      session = await signIn('Read Only');

      expect((await api('get', '/api/v1/stacks')).status).toBe(200);
      expect((await api('get', configuration)).status).toBe(403);

      session = administrator;
      expect((await api('get', configuration)).status).toBe(200);
    }, 120_000);

    it('refuses a viewer who tries to save one', async () => {
      session = await signIn('Read Only');

      const response = await api('post', '/api/v1/stacks', {
        name: 'shop',
        hostId,
        compose: 'services:\n  web:\n    image: nginx\n',
        environment: [],
      });

      expect(response.status).toBe(403);
    }, 120_000);
  });

  describe('where a secret must not appear', () => {
    it('is in no audit entry', async () => {
      const created = await createStack();

      await api('post', `/api/v1/stacks/${created.body.stackId}/revisions`, {
        baseRevisionId: created.body.revisionId,
        compose: COMPOSE,
        environment: [
          { operation: 'set-secret', key: 'DB_PASSWORD', value: ENV_CANARY },
          { operation: 'set', key: 'APP_ENV', value: 'production' },
        ],
      });

      const recorded = await db.client.select().from(auditEntries);
      const kinds = recorded.map((entry) => entry.action);

      expect(kinds).toContain('stack.created');
      expect(kinds).toContain('stack.revision.created');
      expect(JSON.stringify(recorded)).not.toContain(ENV_CANARY);
      expect(JSON.stringify(recorded)).not.toContain('services:');
    }, 120_000);

    it('is in no plain column of any table this writes', async () => {
      await createStack();

      const dump = await db.client.execute<{ found: string }>(
        sql`select coalesce(string_agg(t::text, ' '), '') as found from (
          select s.* from stacks s
        ) t`,
      );

      expect(JSON.stringify(dump.rows)).not.toContain(ENV_CANARY);

      const revisions = await db.client.select().from(stackRevisions);
      const environment = await db.client.select().from(stackRevisionEnvironment);

      expect(JSON.stringify(revisions)).not.toContain(ENV_CANARY);
      // Only the envelope, which is what encryption at rest means.
      expect(JSON.stringify(environment)).not.toContain(ENV_CANARY);
    }, 120_000);
  });

  /*
   * The compiler is another process. A database transaction held open across
   * one would pin a connection to a subprocess for as long as it took — the
   * same rule the container path follows for an agent dispatch.
   */
  describe('what the database is doing while the compiler runs', () => {
    let observer: Database;

    beforeAll(async () => {
      observer = await prepareDatabase();
    });

    afterAll(async () => {
      await observer.onModuleDestroy();
    });

    /*
     * A compiler that takes its time, so the window under observation is the
     * compile and nothing else. The transaction that writes the revision comes
     * after it and is meant to be there.
     */
    const slowCompiler = () => {
      const real = join(workspace, 'compose-compiler');
      const path = join(workspace, 'slow-compose-compiler');

      writeFileSync(path, `#!/bin/sh\nsleep 2\nexec "${real}" "$@"\n`, { mode: 0o755 });

      return path;
    };

    it('holds no transaction open while compiling', async () => {
      process.env.DOCKPLANE_COMPOSE_COMPILER = slowCompiler();

      const saving = createStack();

      let peak = 0;

      try {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          /*
           * This test's own application. Every test file in the run shares one
           * database, so counting every connection would count the ones another
           * file is legitimately using.
           */
          const result = await observer.client.execute<{ count: number }>(
            sql`select count(*)::int as count from pg_stat_activity
                where datname = current_database()
                  and application_name = current_setting('application_name')
                  and state = 'idle in transaction'
                  and pid <> pg_backend_pid()`,
          );

          peak = Math.max(peak, Number(result.rows[0]?.count ?? 0));

          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        expect((await saving).status).toBe(201);
      } finally {
        process.env.DOCKPLANE_COMPOSE_COMPILER = join(workspace, 'compose-compiler');
      }

      expect(peak).toBe(0);
    }, 120_000);
  });
});
