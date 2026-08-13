import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ComposeCompilerService } from '../src/stacks/compose-compiler.service';
import { Database } from '../src/database/database';
import { auditEntries, stacks } from '../src/database/schema';
import {
  DEFAULT_PASSWORD,
  createTestApp,
  resetData,
  resetThrottling,
  seedUser,
  testPki,
} from './app';

const ORIGIN = 'http://localhost:4200';

/** Unmistakable if it ever escaped into a response, a log or the database. */
const CANARY = 'canary-compose-secret-1c0ffee';

/**
 * Checking a Compose file, through the real compiler.
 *
 * The compiler is a separate process, and that boundary is most of what is
 * being tested: it is built here from the repository's own source and the
 * server is pointed at it, so what runs in these tests is what runs in the
 * image.
 *
 * The rule under the most scrutiny is what comes back. The compiler is handed
 * every value including the secrets, because a Compose file cannot be resolved
 * without them, and the answer has to carry none of them.
 */
describe('checking a Compose file', () => {
  let app: INestApplication;
  let db: Database;
  let workspace: string;
  let available = true;

  const compose = (body: unknown, session: { cookie: string; csrf: string }) =>
    request(app.getHttpServer())
      .post('/api/v1/stacks/validate')
      .set('cookie', session.cookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', session.csrf)
      .send(body as object);

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

  let session: { cookie: string; csrf: string };

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'dockplane-compiler-'));

    /*
     * Built from this repository, not downloaded and not stubbed. A test that
     * replaced the compiler would be testing the adapter against a fiction.
     */
    try {
      execFileSync('go', ['build', '-o', join(workspace, 'compose-compiler'), '.'], {
        cwd: join(__dirname, '..', '..', 'compose-compiler'),
        stdio: 'pipe',
      });
    } catch {
      available = false;
    }

    process.env.DOCKPLANE_COMPOSE_COMPILER = join(workspace, 'compose-compiler');

    app = await createTestApp();
    db = app.get(Database);
    await testPki();
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
  });

  const skipWithoutGo = () => {
    if (!available) {
      // Go is how the compiler is built; without it there is nothing to test
      // against, and a stubbed answer would prove nothing.
      throw new Error('the Compose compiler could not be built; install Go to run this suite');
    }
  };

  it('accepts a Compose file and describes what it would create', async () => {
    skipWithoutGo();

    const response = await compose(
      {
        projectName: 'shop',
        compose: [
          'services:',
          '  web:',
          '    image: nginx:1.27',
          '    ports:',
          '      - "8080:80"',
          '    environment:',
          '      DB_PASSWORD: ${DB_PASSWORD}',
          '    volumes:',
          '      - app-data:/data',
          'volumes:',
          '  app-data: {}',
        ].join('\n'),
        environment: [{ key: 'DB_PASSWORD', value: CANARY, secret: true }],
      },
      session,
    );

    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(true);

    const service = response.body.summary.services[0];

    expect(service.name).toBe('web');
    expect(service.image).toBe('nginx:1.27');
    expect(service.ports).toBe(1);

    // Names, never values. This is the whole point of summarising rather than
    // returning the plan.
    expect(service.environment).toEqual(['DB_PASSWORD']);
    expect(JSON.stringify(response.body)).not.toContain(CANARY);

    expect(response.body.summary.volumes[0].name).toBe('app-data');
  }, 120_000);

  it('reports what a Compose file asks for that Dockplane will not do', async () => {
    skipWithoutGo();

    const response = await compose(
      {
        projectName: 'shop',
        compose: 'services:\n  app:\n    build: .\n',
        environment: [],
      },
      session,
    );

    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(false);

    const [problem] = response.body.errors;

    expect(problem.path).toBe('services.app.build');
    expect(problem.code).toBe('COMPOSE_FEATURE_UNSUPPORTED');
    expect(problem.message).toContain('not supported');
  }, 120_000);

  it('says where a Compose file is wrong rather than that something failed', async () => {
    skipWithoutGo();

    const response = await compose(
      {
        projectName: 'shop',
        compose: 'services:\n  app:\n    image: [unclosed\n',
        environment: [],
      },
      session,
    );

    expect(response.body.valid).toBe(false);
    expect(response.body.errors[0].code).toBe('COMPOSE_PARSE_FAILED');
  }, 120_000);

  /*
   * A secret is handed to the compiler and must not come back from anywhere.
   *
   * Checked after a failure as well as after a success: the failure path is
   * where a value is most likely to be quoted back, because that is where
   * something is trying to explain what went wrong.
   */
  it('keeps the values out of the answer, the log and the database', async () => {
    skipWithoutGo();

    for (const source of [
      'services:\n  app:\n    image: ${TAG}\n    privileged: true\n',
      'services:\n  app:\n    image: [unclosed\n',
      'services:\n  app:\n    image: nginx\n    environment:\n      A: ${DB_PASSWORD}\n',
    ]) {
      const response = await compose(
        {
          projectName: 'shop',
          compose: source,
          environment: [
            { key: 'DB_PASSWORD', value: CANARY, secret: true },
            { key: 'TAG', value: CANARY, secret: false },
          ],
        },
        session,
      );

      expect(JSON.stringify(response.body)).not.toContain(CANARY);
    }

    const recorded = await db.client.select().from(auditEntries);

    expect(JSON.stringify(recorded)).not.toContain(CANARY);
  }, 120_000);

  it('stores nothing at all', async () => {
    skipWithoutGo();

    await compose(
      {
        projectName: 'shop',
        compose: 'services:\n  web:\n    image: nginx:1.27\n',
        environment: [{ key: 'DB_PASSWORD', value: CANARY, secret: true }],
      },
      session,
    );

    // Validation is a question, not a change. Nothing about the stack, the
    // Compose file or its environment reaches the database.
    expect(await db.client.select().from(stacks)).toHaveLength(0);
  }, 120_000);

  it('refuses a caller who is not signed in', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/stacks/validate')
      .set('origin', ORIGIN)
      .send({ projectName: 'shop', compose: 'services: {}', environment: [] });

    expect(response.status).toBe(401);
  }, 60_000);

  it('refuses a request that cannot prove it was intended', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/stacks/validate')
      .set('cookie', session.cookie)
      .set('origin', ORIGIN)
      .send({ projectName: 'shop', compose: 'services: {}', environment: [] });

    expect(response.status).toBe(403);
  }, 60_000);

  it('refuses an operator without the permission', async () => {
    const readOnly = await signIn('Read Only');

    const response = await compose(
      { projectName: 'shop', compose: 'services:\n  web:\n    image: nginx\n', environment: [] },
      readOnly,
    );

    expect(response.status).toBe(403);
  }, 60_000);

  it('refuses more than it will read', async () => {
    skipWithoutGo();

    const response = await compose(
      { projectName: 'shop', compose: '#'.repeat(70 * 1024), environment: [] },
      session,
    );

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  }, 120_000);

  it('refuses a field nobody modelled', async () => {
    const response = await compose(
      {
        projectName: 'shop',
        compose: 'services:\n  web:\n    image: nginx\n',
        environment: [],
        deployNow: true,
      },
      session,
    );

    expect(response.status).toBe(400);
  }, 60_000);
});

/**
 * The adapter's own behaviour, without a Compose file in sight.
 *
 * These are about the process boundary: what happens when the thing on the
 * other side of it is missing, slow, or answering with something else.
 */
describe('the compiler boundary', () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'dockplane-compiler-fake-'));
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
    delete process.env.DOCKPLANE_COMPOSE_COMPILER;
  });

  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as never;

  const compileWith = (script: string) => {
    process.env.DOCKPLANE_COMPOSE_COMPILER = writeScript(workspace, script);

    return new ComposeCompilerService(logger).compile({
      projectName: 'shop',
      compose: 'services: {}',
      environment: {},
    });
  };

  it('refuses when there is no compiler to run', async () => {
    await expect(compileWith('')).rejects.toMatchObject({ code: expect.any(String) });
  }, 60_000);

  it('refuses an answer that is not the protocol', async () => {
    await expect(compileWith('echo "not json"')).rejects.toMatchObject({
      code: 'COMPOSE_COMPILER_FAILED',
    });
  }, 60_000);

  it('refuses a plan from a version this build does not speak', async () => {
    await expect(
      compileWith(`echo '{"protocolVersion":99,"ok":true,"plan":{}}'`),
    ).rejects.toMatchObject({ code: 'COMPOSE_COMPILER_FAILED' });
  }, 60_000);

  it('refuses a compiler that exits without answering', async () => {
    await expect(compileWith('exit 3')).rejects.toMatchObject({
      code: 'COMPOSE_COMPILER_FAILED',
    });
  }, 60_000);

  it('refuses a success that carries no plan', async () => {
    await expect(compileWith(`echo '{"protocolVersion":1,"ok":true}'`)).rejects.toMatchObject({
      code: 'COMPOSE_COMPILER_FAILED',
    });
  }, 60_000);

  /*
   * The child is given an environment of its own.
   *
   * Node hands `process.env` to a child by default, which here would hand a
   * Compose parser this server's database URL and encryption key.
   */
  it('does not hand the server’s environment to the compiler', async () => {
    process.env.DOCKPLANE_TEST_MARKER = 'must-not-be-inherited';

    const result = await compileWith(
      `printf '{"protocolVersion":1,"ok":false,"errors":[{"code":"X","message":"%s"}]}\\n' "\${DOCKPLANE_TEST_MARKER:-absent}"`,
    );

    delete process.env.DOCKPLANE_TEST_MARKER;

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems[0].message).toBe('absent');
  }, 60_000);
});

function writeScript(directory: string, script: string): string {
  const path = join(directory, `fake-${Math.random().toString(36).slice(2)}.sh`);

  if (script === '') {
    // A path that does not exist, for the case where the compiler is missing.
    return join(directory, 'not-a-compiler');
  }

  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });

  return path;
}
