import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { Database } from '../src/database/database';
import { composeProjects, containers, hosts } from '../src/database/schema';
import { DEFAULT_PASSWORD, createTestApp, resetData, resetThrottling, seedUser } from './app';

const ORIGIN = 'http://localhost:4200';

/**
 * The read-only inventory API.
 *
 * Authorization is asserted per role rather than assumed from the interface:
 * the frontend is not the boundary, so an operator without a permission has to
 * be refused by the server.
 */
describe('inventory API', () => {
  let app: INestApplication;
  let db: Database;

  const signIn = async (roleName: string) => {
    const user = await seedUser(db, {
      email: `user-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.internal`,
      roleName,
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('origin', ORIGIN)
      .send({ email: user.email, password: DEFAULT_PASSWORD });

    const raw = response.headers['set-cookie'] as unknown as string[];

    return raw.find((entry) => entry.startsWith('dockplane_session='))!.split(';')[0];
  };

  const seedInventory = async (observedAt = new Date()) => {
    const [host] = await db.client
      .insert(hosts)
      .values({
        hostname: 'docker-01',
        os: 'Debian GNU/Linux 13',
        architecture: 'x86_64',
        dockerVersion: '29.0.0',
        metrics: { cpuPercent: 10 },
        observedAt,
        lastSeenAt: observedAt,
      })
      .returning();

    const [project] = await db.client
      .insert(composeProjects)
      .values({
        hostId: host.id,
        projectName: 'shop',
        status: 'running',
        serviceCount: 2,
        runningCount: 2,
        services: [
          { name: 'web', containerIds: ['aaa111'], running: 1, total: 1, state: 'running' },
        ],
        observedAt,
      })
      .returning();

    const [container] = await db.client
      .insert(containers)
      .values({
        hostId: host.id,
        dockerId: 'aaa111',
        name: 'shop-web-1',
        image: 'nginx:1.27',
        state: 'running',
        health: 'healthy',
        composeProjectId: project.id,
        observedAt,
      })
      .returning();

    return { host, project, container };
  };

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

  describe('authorization', () => {
    it('refuses an unauthenticated caller', async () => {
      for (const path of ['/api/v1/hosts', '/api/v1/containers', '/api/v1/compose-projects']) {
        const response = await request(app.getHttpServer()).get(path);

        expect(response.status).toBe(401);
      }
    });

    it('allows a read-only role to read hosts, containers and Compose projects', async () => {
      await seedInventory();
      const cookie = await signIn('Read Only');

      for (const path of ['/api/v1/hosts', '/api/v1/containers', '/api/v1/compose-projects']) {
        const response = await request(app.getHttpServer()).get(path).set('cookie', cookie);

        expect(response.status).toBe(200);
      }
    });

    /**
     * Nothing exists beyond the operations the product defines.
     *
     * Removal, exec, a console and host operations have no route at all — not a
     * route that answers 403, which would mean the code to perform them was
     * written and merely gated. They cannot be reached by any request.
     *
     * Reading logs is absent from this list because it exists: a route behind
     * its own permission that carries output outwards. Writing into a container
     * is not, and there is no route through which it could be.
     */
    it('exposes no operation beyond the ones the product defines', async () => {
      const { host, container } = await seedInventory();
      const cookie = await signIn('Administrator');

      const attempts = [
        ['delete', `/api/v1/containers/${container.id}`],
        ['post', `/api/v1/containers/${container.id}/exec`],
        ['post', `/api/v1/containers/${container.id}/attach`],
        ['post', `/api/v1/containers/${container.id}/kill`],
        ['post', `/api/v1/containers/${container.id}/remove`],
        ['post', `/api/v1/containers/${container.id}/logs`],
        ['post', `/api/v1/containers/${container.id}/logs/input`],
        ['post', `/api/v1/containers/${container.id}/action`],
        ['post', `/api/v1/hosts/${host.id}/reboot`],
        ['post', `/api/v1/compose-projects/${container.id}/up`],
      ] as const;

      for (const [method, path] of attempts) {
        const agent = request(app.getHttpServer());
        const response = await agent[method](path).set('cookie', cookie).set('origin', ORIGIN);

        expect(response.status).toBe(404);
      }
    });
  });

  describe('hosts', () => {
    it('returns a host with its agent state and observation time', async () => {
      const { host } = await seedInventory();
      const cookie = await signIn('Read Only');

      const response = await request(app.getHttpServer())
        .get(`/api/v1/hosts/${host.id}`)
        .set('cookie', cookie);

      expect(response.status).toBe(200);
      expect(response.body.host.hostname).toBe('docker-01');
      expect(response.body.host.observedAt).toBeTruthy();
      expect(response.body.host).toHaveProperty('stale');
    });

    it('answers 404 for an unknown host', async () => {
      const cookie = await signIn('Read Only');

      const response = await request(app.getHttpServer())
        .get('/api/v1/hosts/00000000-0000-4000-8000-000000000000')
        .set('cookie', cookie);

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('HOST_NOT_FOUND');
    });

    it('refuses an identifier that is not a UUID without reaching the database', async () => {
      const cookie = await signIn('Read Only');

      const response = await request(app.getHttpServer())
        .get('/api/v1/hosts/not-a-uuid')
        .set('cookie', cookie);

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('freshness', () => {
    it('marks an old observation as stale', async () => {
      const { host } = await seedInventory(new Date(Date.now() - 10 * 60 * 1000));
      const cookie = await signIn('Read Only');

      const response = await request(app.getHttpServer())
        .get(`/api/v1/hosts/${host.id}`)
        .set('cookie', cookie);

      expect(response.body.host.stale).toBe(true);

      // The last known state is kept: an operator needs to see what a host
      // reported before it went quiet.
      expect(response.body.host.metrics).toMatchObject({ cpuPercent: 10 });
      expect(response.body.host.observedAt).toBeTruthy();
    });

    it('marks a recent observation as current', async () => {
      const { host } = await seedInventory();
      const cookie = await signIn('Read Only');

      const response = await request(app.getHttpServer())
        .get(`/api/v1/hosts/${host.id}`)
        .set('cookie', cookie);

      expect(response.body.host.stale).toBe(false);
    });

    it('reports containers of a quiet host as stale rather than removing them', async () => {
      await seedInventory(new Date(Date.now() - 10 * 60 * 1000));
      const cookie = await signIn('Read Only');

      const response = await request(app.getHttpServer())
        .get('/api/v1/containers')
        .set('cookie', cookie);

      expect(response.body.containers).toHaveLength(1);
      expect(response.body.containers[0].stale).toBe(true);
    });
  });

  describe('containers', () => {
    it('filters by host, state and Compose project', async () => {
      const { host } = await seedInventory();
      const cookie = await signIn('Read Only');

      await db.client.insert(containers).values({
        hostId: host.id,
        dockerId: 'bbb222',
        name: 'standalone',
        image: 'redis:8',
        state: 'exited',
        health: 'none',
        observedAt: new Date(),
      });

      const byState = await request(app.getHttpServer())
        .get('/api/v1/containers?state=running')
        .set('cookie', cookie);

      expect(byState.body.containers).toHaveLength(1);
      expect(byState.body.containers[0].name).toBe('shop-web-1');

      const byProject = await request(app.getHttpServer())
        .get('/api/v1/containers?project=shop')
        .set('cookie', cookie);

      expect(byProject.body.containers).toHaveLength(1);

      const byHost = await request(app.getHttpServer())
        .get(`/api/v1/containers?hostId=${host.id}`)
        .set('cookie', cookie);

      expect(byHost.body.containers).toHaveLength(2);
    });

    it('searches by name and image', async () => {
      await seedInventory();
      const cookie = await signIn('Read Only');

      const response = await request(app.getHttpServer())
        .get('/api/v1/containers?search=nginx')
        .set('cookie', cookie);

      expect(response.body.containers).toHaveLength(1);
    });

    it('paginates and reports the total', async () => {
      const { host } = await seedInventory();
      const cookie = await signIn('Read Only');

      for (let index = 0; index < 5; index += 1) {
        await db.client.insert(containers).values({
          hostId: host.id,
          dockerId: `extra-${index}`,
          name: `extra-${index}`,
          image: 'busybox',
          state: 'running',
          health: 'none',
          observedAt: new Date(),
        });
      }

      const response = await request(app.getHttpServer())
        .get('/api/v1/containers?limit=2&offset=0')
        .set('cookie', cookie);

      expect(response.body.containers).toHaveLength(2);
      expect(response.body.page).toMatchObject({ limit: 2, offset: 0, total: 6 });
    });

    it('refuses a page size beyond the maximum', async () => {
      const cookie = await signIn('Read Only');

      const response = await request(app.getHttpServer())
        .get('/api/v1/containers?limit=5000')
        .set('cookie', cookie);

      expect(response.status).toBe(400);
    });
  });

  describe('compose projects', () => {
    it('returns a project with its containers', async () => {
      const { project } = await seedInventory();
      const cookie = await signIn('Read Only');

      const response = await request(app.getHttpServer())
        .get(`/api/v1/compose-projects/${project.id}`)
        .set('cookie', cookie);

      expect(response.status).toBe(200);
      expect(response.body.project.projectName).toBe('shop');
      expect(response.body.project.containers).toHaveLength(1);
      expect(response.body.project.containers[0].name).toBe('shop-web-1');
    });

    it('answers 404 for an unknown project', async () => {
      const cookie = await signIn('Read Only');

      const response = await request(app.getHttpServer())
        .get('/api/v1/compose-projects/00000000-0000-4000-8000-000000000000')
        .set('cookie', cookie);

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('COMPOSE_PROJECT_NOT_FOUND');
    });
  });
});
