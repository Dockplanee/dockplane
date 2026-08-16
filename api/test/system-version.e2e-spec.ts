import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { MINIMUM_PROTOCOL_VERSION, PROTOCOL_VERSION } from '../src/agents/protocol';
import { Database } from '../src/database/database';
import { agents, hosts } from '../src/database/schema';
import { EXPECTED_SCHEMA_VERSION } from '../src/version/schema-version';
import { RELEASE_PROVIDER } from '../src/version/release-version.service';
import { ReleaseVersionProvider } from '../src/version/release-provider';
import { DEFAULT_PASSWORD, createTestApp, resetData, resetThrottling, seedUser } from './app';

const ORIGIN = 'http://localhost:4200';

const signIn = async (app: INestApplication, email: string) => {
  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('origin', ORIGIN)
    .send({ email, password: DEFAULT_PASSWORD });

  const raw = response.headers['set-cookie'] as unknown as string[];

  return raw.find((entry) => entry.startsWith('dockplane_session='))!.split(';')[0];
};

async function seedAgent(db: Database, version: string | null, protocolVersion = 1) {
  const [host] = await db.client
    .insert(hosts)
    .values({ hostname: `host-${Math.random().toString(36).slice(2, 8)}` })
    .returning({ id: hosts.id });

  await db.client.insert(agents).values({
    hostId: host.id,
    certificateFingerprint: `fp-${Math.random().toString(36).slice(2)}`,
    certificateSerial: `serial-${Math.random().toString(36).slice(2)}`,
    certificateNotAfter: new Date(Date.now() + 86_400_000),
    version,
    protocolVersion,
    status: 'connected',
  });
}

/*
What is installed here, and what the browser is allowed to know about it.

The local answer never depends on the network: an installation with no route
out reports its own versions exactly as one with a route. The check for a
published release is a separate endpoint precisely so that a slow or
unreachable upstream cannot delay the local one.
*/
describe('the installed versions endpoint', () => {
  let app: INestApplication;
  let db: Database;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(Database);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetData(db);
    resetThrottling(app);
  });

  it('refuses an unauthenticated caller', async () => {
    await request(app.getHttpServer()).get('/api/v1/system/versions').expect(401);
  });

  it('reports the build, the schema and the protocol range', async () => {
    const user = await seedUser(db, { email: 'admin@example.internal', roleName: 'Administrator' });
    const cookie = await signIn(app, user.email);

    const response = await request(app.getHttpServer())
      .get('/api/v1/system/versions')
      .set('cookie', cookie)
      .expect(200);

    expect(response.body.controlServer).toEqual({
      version: expect.any(String),
      commit: expect.any(String),
    });
    expect(response.body.schema).toEqual({
      expected: EXPECTED_SCHEMA_VERSION,
      applied: EXPECTED_SCHEMA_VERSION,
      mismatch: false,
    });
    expect(response.body.protocol).toEqual({
      server: PROTOCOL_VERSION,
      minimumSupported: MINIMUM_PROTOCOL_VERSION,
    });
  });

  it('discloses no configuration', async () => {
    const user = await seedUser(db, { email: 'admin@example.internal', roleName: 'Administrator' });
    const cookie = await signIn(app, user.email);

    const response = await request(app.getHttpServer())
      .get('/api/v1/system/versions')
      .set('cookie', cookie)
      .expect(200);

    const serialised = JSON.stringify(response.body).toLowerCase();

    for (const secret of ['postgres://', 'password', 'secret', 'token', 'path', '/etc/']) {
      expect(serialised).not.toContain(secret);
    }
  });

  describe('the agent summary', () => {
    it('counts the fleet for a caller who may see the agents', async () => {
      await seedAgent(db, '0.3.0');
      await seedAgent(db, '0.3.0');
      await seedAgent(db, '0.2.0');

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      const cookie = await signIn(app, user.email);

      const response = await request(app.getHttpServer())
        .get('/api/v1/system/versions')
        .set('cookie', cookie)
        .expect(200);

      expect(response.body.agents).toEqual({
        total: 3,
        versions: [
          { version: '0.3.0', count: 2 },
          { version: '0.2.0', count: 1 },
        ],
        mixedVersions: true,
        unknownCount: 0,
        protocolUnsupportedCount: 0,
        oldestVersion: '0.2.0',
        newestVersion: '0.3.0',
      });
    });

    // Frontend visibility is not authorization: a caller without the agents
    // permission is not sent the fleet and told not to render it.
    it('is withheld from a caller who may not see the agents', async () => {
      await seedAgent(db, '0.3.0');

      const user = await seedUser(db, { email: 'viewer@example.internal', roleName: 'Read Only' });
      const cookie = await signIn(app, user.email);

      const response = await request(app.getHttpServer())
        .get('/api/v1/system/versions')
        .set('cookie', cookie)
        .expect(200);

      expect(response.body.agents).toBeNull();
      expect(response.body.controlServer.version).toEqual(expect.any(String));
    });

    it('leaves a revoked agent out of the fleet', async () => {
      await seedAgent(db, '0.3.0');

      const db2 = db;
      await db2.client
        .insert(agents)
        .values({
          hostId: (
            await db2.client
              .insert(hosts)
              .values({ hostname: 'revoked-host' })
              .returning({ id: hosts.id })
          )[0].id,
          certificateFingerprint: 'fp-revoked',
          certificateSerial: 'serial-revoked',
          certificateNotAfter: new Date(Date.now() + 86_400_000),
          version: '0.1.0',
          protocolVersion: 1,
          status: 'revoked',
          revokedAt: new Date(),
        });

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      const cookie = await signIn(app, user.email);

      const response = await request(app.getHttpServer())
        .get('/api/v1/system/versions')
        .set('cookie', cookie)
        .expect(200);

      expect(response.body.agents.total).toBe(1);
      expect(response.body.agents.mixedVersions).toBe(false);
    });

    it('reports an agent that has never named a version', async () => {
      await seedAgent(db, null);

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      const cookie = await signIn(app, user.email);

      const response = await request(app.getHttpServer())
        .get('/api/v1/system/versions')
        .set('cookie', cookie)
        .expect(200);

      expect(response.body.agents.unknownCount).toBe(1);
      expect(response.body.agents.versions).toEqual([{ version: null, count: 1 }]);
    });
  });
});

/*
The check that is off.

This is the product promise: an installation that was not asked to look for
updates makes no request to anybody. The provider counts what it is asked, so
the assertion is about behaviour rather than about a comment.
*/
describe('the update check, shipped as it is', () => {
  let app: INestApplication;
  let db: Database;
  let consulted: number;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(Database);

    const provider = app.get<ReleaseVersionProvider>(RELEASE_PROVIDER);
    consulted = 0;
    jest.spyOn(provider, 'latestStable').mockImplementation(async () => {
      consulted += 1;
      return { version: '9.9.9', url: null };
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetData(db);
    resetThrottling(app);
    consulted = 0;
  });

  it('refuses an unauthenticated caller', async () => {
    await request(app.getHttpServer()).get('/api/v1/system/update-check').expect(401);
    expect(consulted).toBe(0);
  });

  it('answers that it is off, without asking anybody', async () => {
    const user = await seedUser(db, { email: 'admin@example.internal', roleName: 'Administrator' });
    const cookie = await signIn(app, user.email);

    const response = await request(app.getHttpServer())
      .get('/api/v1/system/update-check')
      .set('cookie', cookie)
      .expect(200);

    expect(response.body).toEqual({
      state: 'disabled',
      latestStableVersion: null,
      releaseUrl: null,
      checkedAt: null,
      updateAvailable: null,
      stale: false,
    });
    expect(consulted).toBe(0);
  });

  it('claims no available version however often it is asked', async () => {
    const user = await seedUser(db, { email: 'admin@example.internal', roleName: 'Administrator' });
    const cookie = await signIn(app, user.email);

    for (let i = 0; i < 10; i += 1) {
      const response = await request(app.getHttpServer())
        .get('/api/v1/system/update-check')
        .set('cookie', cookie)
        .expect(200);

      expect(response.body.state).toBe('disabled');
    }

    expect(consulted).toBe(0);
  });
});

/*
The check an administrator turned on.

Each case gets an installation of its own. The cache is per process and holds
its answer for hours, which is the behaviour being relied on elsewhere — so a
case that needs a first check has to start from an installation that has not
made one.
*/
describe('the update check, turned on', () => {
  type Answer = () => Promise<{ version: string; url: string | null } | null>;

  interface Installation {
    readonly app: INestApplication;
    readonly db: Database;
    readonly consulted: () => number;
  }

  const installations: INestApplication[] = [];

  async function withUpdateCheck(answer: Answer): Promise<Installation> {
    const app = await createTestApp({ env: { UPDATE_CHECK_ENABLED: 'true' } });
    installations.push(app);

    let consulted = 0;
    const provider = app.get<ReleaseVersionProvider>(RELEASE_PROVIDER);

    jest.spyOn(provider, 'latestStable').mockImplementation(async () => {
      consulted += 1;
      return answer();
    });

    return { app, db: app.get(Database), consulted: () => consulted };
  }

  async function status(installation: Installation, email = 'admin@example.internal') {
    await resetThrottling(installation.app);
    const user = await seedUser(installation.db, { email, roleName: 'Administrator' });
    const cookie = await signIn(installation.app, user.email);

    const response = await request(installation.app.getHttpServer())
      .get('/api/v1/system/update-check')
      .set('cookie', cookie)
      .expect(200);

    return { body: response.body, cookie };
  }

  afterAll(async () => {
    for (const app of installations) {
      await app.close();
    }
  });

  it('reports a newer published release', async () => {
    const installation = await withUpdateCheck(async () => ({
      version: '9.9.9',
      url: 'https://example.test/9.9.9',
    }));
    await resetData(installation.db);

    const { body } = await status(installation);

    expect(body.state).toBe('ok');
    expect(body.latestStableVersion).toBe('9.9.9');
    expect(body.releaseUrl).toBe('https://example.test/9.9.9');
    expect(body.updateAvailable).toBe(true);
    expect(body.checkedAt).toEqual(expect.any(String));
  });

  it('asks the upstream once and answers the rest from what it has', async () => {
    const installation = await withUpdateCheck(async () => ({ version: '9.9.9', url: null }));
    await resetData(installation.db);

    await status(installation, 'one@example.internal');
    await status(installation, 'two@example.internal');
    await status(installation, 'three@example.internal');

    expect(installation.consulted()).toBe(1);
  });

  it('stays usable when the upstream cannot be reached', async () => {
    const installation = await withUpdateCheck(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    await resetData(installation.db);

    const { body, cookie } = await status(installation);

    expect(body.state).toBe('unavailable');
    expect(body.latestStableVersion).toBeNull();

    // And the rest of the product is unaffected.
    await request(installation.app.getHttpServer())
      .get('/api/v1/system/versions')
      .set('cookie', cookie)
      .expect(200);
    await request(installation.app.getHttpServer())
      .get('/api/v1/hosts')
      .set('cookie', cookie)
      .expect(200);
  });

  it('reports an upstream release it cannot read a version from', async () => {
    const installation = await withUpdateCheck(async () => null);
    await resetData(installation.db);

    const { body } = await status(installation);

    expect(body.state).toBe('unsupported');
    expect(body.updateAvailable).toBeNull();
  });
});
