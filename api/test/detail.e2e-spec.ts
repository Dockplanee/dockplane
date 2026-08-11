import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { AgentGatewayService } from '../src/agents/agent-gateway.service';
import { Database } from '../src/database/database';
import { DiscoveryService } from '../src/discovery/discovery.service';
import { composeProjects, containers } from '../src/database/schema';
import { TestAgentConnection } from './agent-client';
import { createAgentCsr } from './agent-pki';
import {
  DEFAULT_PASSWORD,
  createTestApp,
  resetData,
  resetThrottling,
  seedUser,
  testPki,
} from './app';

const ORIGIN = 'http://localhost:4200';

const SECRET = 'THIS-MUST-NEVER-LEAVE-THE-HOST';

interface Reply {
  capability: string;
  payload?: unknown;
  error?: { code: string; message: string };
  /** Answers with a capability other than the one requested. */
  answerAs?: string;
  /** Answers with an identifier the server never issued. */
  answerId?: string;
  /** Never answers, so the request runs into its timeout. */
  silent?: boolean;
}

/**
 * Container and Compose detail.
 *
 * Detail is read from the host on demand rather than assembled from the
 * summary, so these tests script a real agent over mTLS and assert what the
 * server asks for, what it keeps and what it refuses to keep.
 */
describe('inspect detail', () => {
  let app: INestApplication;
  let db: Database;
  let discovery: DiscoveryService;
  let port: number;
  let caPem: string;
  let cookie: string;
  let csrf: string;

  const signInAsAdmin = async () => {
    const user = await seedUser(db, {
      email: `admin-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.internal`,
      roleName: 'Administrator',
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('origin', ORIGIN)
      .send({ email: user.email, password: DEFAULT_PASSWORD });

    const raw = response.headers['set-cookie'] as unknown as string[];
    cookie = raw.find((entry) => entry.startsWith('dockplane_session='))!.split(';')[0];
    csrf = response.body.csrfToken;
  };

  const enrollAgent = async (hostname = 'docker-01') => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/agents/enrollment-tokens')
      .set('cookie', cookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', csrf)
      .send({ intendedHostname: hostname });

    const { csrPem, privateKeyPem } = await createAgentCsr();

    const enrolled = await request(app.getHttpServer())
      .post('/api/v1/agent-enrollments')
      .send({ token: created.body.token, csr: csrPem, protocolVersion: 1, hostname });

    return {
      agentId: enrolled.body.agentId as string,
      certificatePem: enrolled.body.certificate as string,
      privateKeyPem,
    };
  };

  /** Records what the server asked for, so a test can assert the dispatch. */
  const dispatched: string[] = [];

  const connectScripted = async (
    agent: { certificatePem: string; privateKeyPem: string },
    replies: Reply[],
  ) => {
    const connection = await TestAgentConnection.open({ port, caPem, ...agent });

    connection.send({ type: 'hello', protocolVersion: 1 });
    await connection.waitFor('hello_ack');

    connection.onMessage((message) => {
      if (message.type !== 'request') {
        return;
      }

      dispatched.push(String(message.capability));

      const scripted = replies.find((reply) => reply.capability === message.capability);

      if (!scripted || scripted.silent) {
        return;
      }

      connection.send({
        type: 'response',
        protocolVersion: 1,
        id: scripted.answerId ?? message.id,
        capability: scripted.answerAs ?? message.capability,
        status: scripted.error ? 'error' : 'success',
        payload: scripted.payload,
        error: scripted.error,
      });
    });

    return connection;
  };

  const listReplies = (): Reply[] => [
    {
      capability: 'host.inventory',
      payload: {
        hostname: 'docker-01',
        dockerVersion: '29.0.0',
        observedAt: new Date().toISOString(),
      },
    },
    { capability: 'host.metrics', payload: { cpuPercent: 5 } },
    {
      capability: 'container.list',
      payload: {
        containers: [
          {
            dockerId: 'aaa111',
            name: 'shop-web-1',
            image: 'nginx:1.27',
            state: 'running',
            status: 'Up 2 hours',
            health: 'healthy',
            createdAt: new Date().toISOString(),
            labels: {
              'com.docker.compose.project': 'shop',
              'com.docker.compose.service': 'web',
            },
          },
        ],
      },
    },
    {
      capability: 'compose.list',
      payload: {
        projects: [
          {
            projectName: 'shop',
            status: 'running',
            serviceCount: 1,
            runningCount: 1,
            services: [
              { name: 'web', containerIds: ['aaa111'], running: 1, total: 1, state: 'running' },
            ],
          },
        ],
      },
    },
  ];

  /** The projection an honest agent sends for container.inspect. */
  const inspectPayload = (overrides: Record<string, unknown> = {}) => ({
    container: {
      dockerId: 'aaa111',
      name: 'shop-web-1',
      image: 'nginx:1.27',
      imageId: 'sha256:cafebabe',
      state: 'running',
      status: 'running',
      health: 'healthy',
      restartCount: 2,
      restartPolicy: 'unless-stopped',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      ports: [{ containerPort: 80, protocol: 'tcp', hostPort: '8080', hostIp: '127.0.0.1' }],
      networks: ['shop_default'],
      mounts: [
        { type: 'volume', name: 'shop_data', readOnly: false },
        { type: 'bind', readOnly: true },
      ],
      limits: { memoryBytes: 536870912, nanoCpus: 1500000000, pidsLimit: 100 },
      labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'web' },
      ...overrides,
    },
    observedAt: new Date().toISOString(),
  });

  const composePayload = () => ({
    project: {
      projectName: 'shop',
      status: 'degraded',
      serviceCount: 2,
      runningCount: 1,
      services: [
        { name: 'web', containerIds: ['aaa111'], running: 1, total: 1, state: 'running' },
        { name: 'worker', containerIds: ['bbb222'], running: 0, total: 1, state: 'stopped' },
      ],
    },
    observedAt: new Date().toISOString(),
  });

  /** Enrolls, connects, runs one discovery pass and returns the stored rows. */
  const discovered = async (replies: Reply[]) => {
    const agent = await enrollAgent();
    const connection = await connectScripted(agent, replies);

    await discovery.sync(agent.agentId);

    const [container] = await db.client.select().from(containers);
    const [project] = await db.client.select().from(composeProjects);

    return { agent, connection, container, project };
  };

  const getContainer = (id: string) =>
    request(app.getHttpServer()).get(`/api/v1/containers/${id}`).set('cookie', cookie);

  const getProject = (id: string) =>
    request(app.getHttpServer()).get(`/api/v1/compose-projects/${id}`).set('cookie', cookie);

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(Database);
    discovery = app.get(DiscoveryService);
    port = app.get(AgentGatewayService).port;
    caPem = (await testPki()).caCertPem;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetData(db);
    resetThrottling(app);
    dispatched.length = 0;
    await signInAsAdmin();
  });

  describe('container detail', () => {
    it('dispatches container.inspect and returns the projection', async () => {
      const { connection, container } = await discovered([
        ...listReplies(),
        { capability: 'container.inspect', payload: inspectPayload() },
      ]);

      const response = await getContainer(container.id);

      expect(response.status).toBe(200);
      expect(dispatched).toContain('container.inspect');

      const detail = response.body.container.detail;

      expect(detail.dockerId).toBe('aaa111');
      expect(detail.restartPolicy).toBe('unless-stopped');
      expect(detail.ports).toEqual([
        { containerPort: 80, protocol: 'tcp', hostPort: '8080', hostIp: '127.0.0.1' },
      ]);
      expect(detail.networks).toEqual(['shop_default']);
      expect(detail.limits).toMatchObject({ pidsLimit: 100 });
      expect(response.body.container.stale).toBe(false);
      expect(response.body.container.detailObservedAt).toBeTruthy();

      connection.close();
    });

    it('persists the projection', async () => {
      const { connection, container } = await discovered([
        ...listReplies(),
        { capability: 'container.inspect', payload: inspectPayload() },
      ]);

      await getContainer(container.id);

      const [stored] = await db.client
        .select()
        .from(containers)
        .where(eq(containers.id, container.id));

      expect(stored.detail).toMatchObject({ dockerId: 'aaa111', restartCount: 2 });
      expect(stored.detailObservedAt).not.toBeNull();

      connection.close();
    });

    /**
     * The server rebuilds the record from the fields the product defines, so an
     * agent that reported more than it should cannot put that data into the
     * control server's database.
     */
    it('drops anything the projection does not define', async () => {
      const { connection, container } = await discovered([
        ...listReplies(),
        {
          capability: 'container.inspect',
          payload: inspectPayload({
            env: [`POSTGRES_PASSWORD=${SECRET}`],
            config: { Env: [`AWS_SECRET_ACCESS_KEY=${SECRET}`] },
            command: ['postgres', '-c', `password=${SECRET}`],
            entrypoint: ['/docker-entrypoint.sh'],
            registryCredentials: { username: 'ops', password: SECRET },
            labels: {
              'com.docker.compose.project': 'shop',
              'internal.deploy.token': SECRET,
            },
            mounts: [{ type: 'bind', name: '/home/operator/secrets', readOnly: true }],
          }),
        },
      ]);

      const response = await getContainer(container.id);

      const serialisedResponse = JSON.stringify(response.body);

      expect(serialisedResponse).not.toContain(SECRET);
      expect(serialisedResponse).not.toContain('AWS_SECRET_ACCESS_KEY');
      expect(serialisedResponse).not.toContain('/home/operator/secrets');
      expect(serialisedResponse).not.toContain('docker-entrypoint');

      const [stored] = await db.client
        .select()
        .from(containers)
        .where(eq(containers.id, container.id));

      const serialisedRow = JSON.stringify(stored);

      expect(serialisedRow).not.toContain(SECRET);
      expect(serialisedRow).not.toContain('registryCredentials');
      expect(serialisedRow).not.toContain('entrypoint');

      // The bind mount is still reported as present, without its source path.
      const bind = response.body.container.detail.mounts.find(
        (mount: { type: string }) => mount.type === 'bind',
      );

      expect(bind).toBeDefined();
      expect(bind.name).toBeUndefined();

      connection.close();
    });

    it('does not ask the host again while the projection is fresh', async () => {
      const { connection, container } = await discovered([
        ...listReplies(),
        { capability: 'container.inspect', payload: inspectPayload() },
      ]);

      await getContainer(container.id);
      const afterFirst = dispatched.filter((name) => name === 'container.inspect').length;

      await getContainer(container.id);
      await getContainer(container.id);

      const afterThird = dispatched.filter((name) => name === 'container.inspect').length;

      expect(afterFirst).toBe(1);
      expect(afterThird).toBe(1);

      connection.close();
    });

    it('shares one dispatch between concurrent requests', async () => {
      const { connection, container } = await discovered([
        ...listReplies(),
        { capability: 'container.inspect', payload: inspectPayload() },
      ]);

      const responses = await Promise.all([
        getContainer(container.id),
        getContainer(container.id),
        getContainer(container.id),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(200);
      }

      expect(dispatched.filter((name) => name === 'container.inspect')).toHaveLength(1);

      connection.close();
    });

    it('returns the last known projection as stale when the agent is gone', async () => {
      const { connection, container } = await discovered([
        ...listReplies(),
        { capability: 'container.inspect', payload: inspectPayload() },
      ]);

      await getContainer(container.id);

      // Age the stored projection past the freshness window, then disconnect.
      await db.client
        .update(containers)
        .set({ detailObservedAt: new Date(Date.now() - 60_000) })
        .where(eq(containers.id, container.id));

      connection.close();
      await connection.waitForClose();

      const response = await getContainer(container.id);

      expect(response.status).toBe(200);
      expect(response.body.container.stale).toBe(true);
      expect(response.body.container.detail.dockerId).toBe('aaa111');
    });

    it('reports a stable code when nothing was ever inspected and the agent is gone', async () => {
      const { connection, container } = await discovered(listReplies());

      connection.close();
      await connection.waitForClose();

      const response = await getContainer(container.id);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONTAINER_DETAIL_UNAVAILABLE');
      expect(response.body).not.toHaveProperty('container');
    });

    it('reports the container as gone when the host says it no longer exists', async () => {
      const { connection, container } = await discovered([
        ...listReplies(),
        {
          capability: 'container.inspect',
          error: { code: 'CONTAINER_NOT_FOUND', message: 'No such container.' },
        },
      ]);

      const response = await getContainer(container.id);

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('CONTAINER_NOT_FOUND');

      const remaining = await db.client.select().from(containers);
      expect(remaining).toHaveLength(0);

      connection.close();
    });

    /**
     * The agent is connected but never answers.
     *
     * The request runs into the capability timeout and the stored projection is
     * what the operator sees, marked stale because it is. The timeout is what
     * keeps one unresponsive host from holding a request open indefinitely.
     */
    it('falls back to the stored projection when a dispatch times out', async () => {
      const { agent, connection, container } = await discovered([
        ...listReplies(),
        { capability: 'container.inspect', payload: inspectPayload() },
      ]);

      await getContainer(container.id);

      connection.close();
      await connection.waitForClose();

      // Age the projection so the next request has to go to the host.
      await db.client
        .update(containers)
        .set({ detailObservedAt: new Date(Date.now() - 60_000) })
        .where(eq(containers.id, container.id));

      const silent = await connectScripted(agent, [
        { capability: 'container.inspect', silent: true },
      ]);

      const started = Date.now();
      const response = await getContainer(container.id);
      const elapsed = Date.now() - started;

      expect(response.status).toBe(200);
      expect(response.body.container.stale).toBe(true);
      expect(response.body.container.detail.dockerId).toBe('aaa111');

      // Bounded rather than left hanging.
      expect(elapsed).toBeLessThan(30_000);

      silent.close();
    }, 60_000);

    it('reports the stable code when a dispatch times out and nothing was stored', async () => {
      const { connection, container } = await discovered([
        ...listReplies(),
        { capability: 'container.inspect', silent: true },
      ]);

      const response = await getContainer(container.id);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONTAINER_DETAIL_UNAVAILABLE');

      connection.close();
    }, 60_000);

    it('does not accept a reply carrying an identifier the server never issued', async () => {
      const { connection, container } = await discovered([
        ...listReplies(),
        {
          capability: 'container.inspect',
          answerId: '00000000-0000-4000-8000-000000000000',
          payload: inspectPayload(),
        },
      ]);

      const response = await getContainer(container.id);

      // The reply is refused, the connection is closed, and the request fails
      // rather than being satisfied by an answer nobody asked for.
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONTAINER_DETAIL_UNAVAILABLE');

      const [stored] = await db.client
        .select()
        .from(containers)
        .where(eq(containers.id, container.id));

      expect(stored.detail).toBeNull();

      connection.close();
    });

    it('does not accept a reply that answers a different capability', async () => {
      const { connection, container } = await discovered([
        ...listReplies(),
        { capability: 'container.inspect', answerAs: 'host.metrics', payload: inspectPayload() },
      ]);

      const response = await getContainer(container.id);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONTAINER_DETAIL_UNAVAILABLE');

      connection.close();
    });
  });

  describe('compose detail', () => {
    it('dispatches compose.inspect and returns the normalised services', async () => {
      const { connection, project } = await discovered([
        ...listReplies(),
        { capability: 'compose.inspect', payload: composePayload() },
      ]);

      const response = await getProject(project.id);

      expect(response.status).toBe(200);
      expect(dispatched).toContain('compose.inspect');

      expect(response.body.project.services).toEqual([
        { name: 'web', containerIds: ['aaa111'], running: 1, total: 1, state: 'running' },
        { name: 'worker', containerIds: ['bbb222'], running: 0, total: 1, state: 'stopped' },
      ]);

      expect(response.body.project.status).toBe('degraded');
      expect(response.body.project.serviceCount).toBe(2);
      expect(response.body.project.stale).toBe(false);

      // The containers the project owns come from the registry, not the host.
      expect(response.body.project.containers).toHaveLength(1);
      expect(response.body.project.containers[0].name).toBe('shop-web-1');

      connection.close();
    });

    it('keeps nothing beyond the defined service fields', async () => {
      const { connection, project } = await discovered([
        ...listReplies(),
        {
          capability: 'compose.inspect',
          payload: {
            project: {
              projectName: 'shop',
              status: 'running',
              workingDir: '/home/operator/stacks/shop',
              configFiles: '/home/operator/stacks/shop/compose.yaml',
              labels: { 'internal.deploy.token': SECRET },
              services: [
                {
                  name: 'web',
                  containerIds: ['aaa111'],
                  running: 1,
                  total: 1,
                  state: 'running',
                  environment: [`DB_PASSWORD=${SECRET}`],
                },
              ],
            },
          },
        },
      ]);

      const response = await getProject(project.id);

      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain(SECRET);
      expect(serialised).not.toContain('/home/operator/stacks');
      expect(serialised).not.toContain('environment');

      const [stored] = await db.client
        .select()
        .from(composeProjects)
        .where(eq(composeProjects.id, project.id));

      expect(JSON.stringify(stored)).not.toContain(SECRET);
      expect(JSON.stringify(stored)).not.toContain('/home/operator/stacks');

      connection.close();
    });

    it('returns the last known services as stale when the agent is gone', async () => {
      const { connection, project } = await discovered([
        ...listReplies(),
        { capability: 'compose.inspect', payload: composePayload() },
      ]);

      await getProject(project.id);

      await db.client
        .update(composeProjects)
        .set({ detailObservedAt: new Date(Date.now() - 60_000) })
        .where(eq(composeProjects.id, project.id));

      connection.close();
      await connection.waitForClose();

      const response = await getProject(project.id);

      expect(response.status).toBe(200);
      expect(response.body.project.stale).toBe(true);
      expect(response.body.project.services).toHaveLength(2);
    });

    it('answers 404 for an unknown project', async () => {
      const response = await getProject('00000000-0000-4000-8000-000000000000');

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('COMPOSE_PROJECT_NOT_FOUND');
    });

    it('does not ask the host again while the services are fresh', async () => {
      const { connection, project } = await discovered([
        ...listReplies(),
        { capability: 'compose.inspect', payload: composePayload() },
      ]);

      await getProject(project.id);
      await getProject(project.id);

      expect(dispatched.filter((name) => name === 'compose.inspect')).toHaveLength(1);

      connection.close();
    });
  });

  describe('authorization', () => {
    it('requires containers.read for container detail', async () => {
      const { connection, container } = await discovered([
        ...listReplies(),
        { capability: 'container.inspect', payload: inspectPayload() },
      ]);

      const user = await seedUser(db, {
        email: `nobody-${Date.now()}@example.internal`,
      });

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('origin', ORIGIN)
        .send({ email: user.email, password: DEFAULT_PASSWORD });

      const raw = login.headers['set-cookie'] as unknown as string[];
      const unprivileged = raw
        .find((entry) => entry.startsWith('dockplane_session='))!
        .split(';')[0];

      const response = await request(app.getHttpServer())
        .get(`/api/v1/containers/${container.id}`)
        .set('cookie', unprivileged);

      expect(response.status).toBe(403);
      expect(dispatched).not.toContain('container.inspect');

      connection.close();
    });

    /**
     * The capability is chosen by the server from its catalog. A caller names a
     * record; it has no way to name an operation.
     */
    it('offers no way to name a capability in the request', async () => {
      const { connection, container } = await discovered([
        ...listReplies(),
        { capability: 'container.inspect', payload: inspectPayload() },
      ]);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/containers/${container.id}`)
        .query({ capability: 'container.remove', action: 'container.stop' })
        .set('cookie', cookie);

      expect(response.status).toBe(200);
      expect(dispatched).toEqual(
        expect.arrayContaining(['host.inventory', 'container.list', 'container.inspect']),
      );
      expect(dispatched).not.toContain('container.remove');
      expect(dispatched).not.toContain('container.stop');

      connection.close();
    });
  });
});
