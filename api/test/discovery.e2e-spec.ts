import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { AgentGatewayService } from '../src/agents/agent-gateway.service';
import { Database } from '../src/database/database';
import { DiscoveryService } from '../src/discovery/discovery.service';
import { composeProjects, containers, events, hosts } from '../src/database/schema';
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

interface Reply {
  capability: string;
  payload?: unknown;
  error?: { code: string; message: string };
}

/**
 * Discovery against a scripted agent.
 *
 * The agent side is a real mTLS connection answering real requests, so what is
 * under test is the server's handling of what an agent reports: which fields it
 * stores, what it removes, and above all what it refuses to remove.
 */
describe('discovery', () => {
  let app: INestApplication;
  let db: Database;
  let discovery: DiscoveryService;
  let port: number;
  let caPem: string;
  let adminCookie: string;
  let adminCsrf: string;

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
    adminCookie = raw.find((entry) => entry.startsWith('dockplane_session='))!.split(';')[0];
    adminCsrf = response.body.csrfToken;
  };

  const enrollAgent = async (hostname = 'docker-01') => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/agents/enrollment-tokens')
      .set('cookie', adminCookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', adminCsrf)
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

  /**
   * Connects and answers capability requests from a script.
   *
   * A capability with no scripted answer is refused, which is how a partial
   * sync is produced deliberately rather than by timing.
   */
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

      const scripted = replies.find((reply) => reply.capability === message.capability);

      if (!scripted) {
        connection.send({
          type: 'response',
          protocolVersion: 1,
          id: message.id,
          capability: message.capability,
          status: 'error',
          error: { code: 'DOCKER_UNAVAILABLE', message: 'Not scripted for this test.' },
        });

        return;
      }

      connection.send({
        type: 'response',
        protocolVersion: 1,
        id: message.id,
        capability: message.capability,
        status: scripted.error ? 'error' : 'success',
        payload: scripted.payload,
        error: scripted.error,
      });
    });

    return connection;
  };

  const inventoryReply = (hostname: string): Reply => ({
    capability: 'host.inventory',
    payload: {
      hostname,
      os: 'Debian GNU/Linux',
      osVersion: '13',
      architecture: 'x86_64',
      kernel: '6.12.0',
      cpuCount: 8,
      memoryTotalBytes: 33_554_432_000,
      dockerVersion: '29.0.0',
      agentVersion: '1.0.0',
      observedAt: new Date().toISOString(),
    },
  });

  const metricsReply = (): Reply => ({
    capability: 'host.metrics',
    payload: { cpuPercent: 12.5, memoryUsedBytes: 100, observedAt: new Date().toISOString() },
  });

  const container = (dockerId: string, name: string, state = 'running', project?: string) => ({
    dockerId,
    name,
    image: 'nginx:1.27',
    imageId: 'sha256:abc',
    state,
    status: state === 'running' ? 'Up 2 hours' : 'Exited (0)',
    health: 'none',
    createdAt: new Date().toISOString(),
    labels: project
      ? { 'com.docker.compose.project': project, 'com.docker.compose.service': name }
      : undefined,
  });

  /** A container Dockplane built, carrying the identity it was given. */
  const managed = (dockerId: string, name: string, containerId: string, state = 'running') => ({
    ...container(dockerId, name, state),
    labels: { 'io.dockplane.managed': 'true', 'io.dockplane.container-id': containerId },
  });

  /** The same, also saying which of its configurations it is running. */
  const applying = (
    dockerId: string,
    name: string,
    containerId: string,
    desiredConfigId: string,
  ) => ({
    ...managed(dockerId, name, containerId),
    labels: {
      'io.dockplane.managed': 'true',
      'io.dockplane.container-id': containerId,
      'io.dockplane.desired-config-id': desiredConfigId,
    },
  });

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
    await signInAsAdmin();
  });

  it('stores the reported host inventory and metrics', async () => {
    const agent = await enrollAgent();
    const connection = await connectScripted(agent, [
      inventoryReply('docker-01'),
      metricsReply(),
      { capability: 'container.list', payload: { containers: [] } },
      { capability: 'compose.list', payload: { projects: [] } },
    ]);

    const result = await discovery.sync(agent.agentId);

    expect(result.complete).toBe(true);

    const [host] = await db.client.select().from(hosts);

    expect(host.hostname).toBe('docker-01');
    expect(host.os).toBe('Debian GNU/Linux 13');
    expect(host.dockerVersion).toBe('29.0.0');
    expect(host.observedAt).not.toBeNull();
    expect(host.metrics).toMatchObject({ cpuPercent: 12.5 });

    connection.close();
  });

  it('records discovered containers and their Compose project', async () => {
    const agent = await enrollAgent();
    const connection = await connectScripted(agent, [
      inventoryReply('docker-01'),
      metricsReply(),
      {
        capability: 'container.list',
        payload: { containers: [container('aaa', 'shop-web-1', 'running', 'shop')] },
      },
      {
        capability: 'compose.list',
        payload: {
          projects: [{ projectName: 'shop', status: 'running', serviceCount: 1, runningCount: 1 }],
        },
      },
    ]);

    await discovery.sync(agent.agentId);

    const rows = await db.client.select().from(containers);

    expect(rows).toHaveLength(1);
    expect(rows[0].dockerId).toBe('aaa');
    expect(rows[0].composeProjectId).not.toBeNull();

    const projects = await db.client.select().from(composeProjects);
    expect(projects).toHaveLength(1);
    expect(projects[0].projectName).toBe('shop');

    connection.close();
  });

  it('removes what a complete pass no longer sees', async () => {
    const agent = await enrollAgent();

    const first = await connectScripted(agent, [
      inventoryReply('docker-01'),
      metricsReply(),
      {
        capability: 'container.list',
        payload: { containers: [container('aaa', 'web'), container('bbb', 'db')] },
      },
      { capability: 'compose.list', payload: { projects: [] } },
    ]);

    await discovery.sync(agent.agentId);
    expect(await db.client.select().from(containers)).toHaveLength(2);

    first.close();

    const second = await connectScripted(agent, [
      inventoryReply('docker-01'),
      metricsReply(),
      { capability: 'container.list', payload: { containers: [container('aaa', 'web')] } },
      { capability: 'compose.list', payload: { projects: [] } },
    ]);

    const result = await discovery.sync(agent.agentId);

    expect(result.complete).toBe(true);
    expect(result.removed).toBe(1);

    const rows = await db.client.select().from(containers);
    expect(rows).toHaveLength(1);
    expect(rows[0].dockerId).toBe('aaa');

    second.close();
  });

  /**
   * The property that makes discovery safe to run against a flaky host.
   *
   * A pass that could not read everything must not conclude that what it did
   * not see is gone. Containers still running would otherwise vanish from the
   * interface because one request failed.
   */
  it('keeps existing records when a pass is incomplete', async () => {
    const agent = await enrollAgent();

    const first = await connectScripted(agent, [
      inventoryReply('docker-01'),
      metricsReply(),
      {
        capability: 'container.list',
        payload: { containers: [container('aaa', 'web'), container('bbb', 'db')] },
      },
      { capability: 'compose.list', payload: { projects: [] } },
    ]);

    await discovery.sync(agent.agentId);
    first.close();

    // Docker is down: container.list fails, everything else still answers.
    const second = await connectScripted(agent, [
      inventoryReply('docker-01'),
      metricsReply(),
      { capability: 'compose.list', payload: { projects: [] } },
    ]);

    const result = await discovery.sync(agent.agentId);

    expect(result.complete).toBe(false);
    expect(result.removed).toBe(0);

    const rows = await db.client.select().from(containers);
    expect(rows).toHaveLength(2);

    const failures = await db.client
      .select()
      .from(events)
      .where(eq(events.type, 'inventory.sync.failed'));

    expect(failures.length).toBeGreaterThan(0);

    second.close();
  });

  it('records a state change once rather than on every pass', async () => {
    const agent = await enrollAgent();

    const first = await connectScripted(agent, [
      inventoryReply('docker-01'),
      metricsReply(),
      {
        capability: 'container.list',
        payload: { containers: [container('aaa', 'web', 'running')] },
      },
      { capability: 'compose.list', payload: { projects: [] } },
    ]);

    await discovery.sync(agent.agentId);
    await discovery.sync(agent.agentId);
    first.close();

    const discovered = await db.client
      .select()
      .from(events)
      .where(eq(events.type, 'container.discovered'));

    expect(discovered).toHaveLength(1);

    const unchanged = await db.client
      .select()
      .from(events)
      .where(eq(events.type, 'container.state.changed'));

    expect(unchanged).toHaveLength(0);

    const second = await connectScripted(agent, [
      inventoryReply('docker-01'),
      metricsReply(),
      {
        capability: 'container.list',
        payload: { containers: [container('aaa', 'web', 'exited')] },
      },
      { capability: 'compose.list', payload: { projects: [] } },
    ]);

    await discovery.sync(agent.agentId);

    const changed = await db.client
      .select()
      .from(events)
      .where(eq(events.type, 'container.state.changed'));

    expect(changed).toHaveLength(1);

    second.close();
  });

  it('never stores container environment values', async () => {
    const agent = await enrollAgent();

    // An agent that misbehaved and sent an environment block: the server stores
    // only the fields it projects, so the extra data has nowhere to land.
    const rogue = {
      ...container('aaa', 'web'),
      env: ['POSTGRES_PASSWORD=super-secret-value'],
      config: { Env: ['AWS_SECRET_ACCESS_KEY=another-secret'] },
    };

    const connection = await connectScripted(agent, [
      inventoryReply('docker-01'),
      metricsReply(),
      { capability: 'container.list', payload: { containers: [rogue] } },
      { capability: 'compose.list', payload: { projects: [] } },
    ]);

    await discovery.sync(agent.agentId);

    const rows = await db.client.select().from(containers);
    const serialised = JSON.stringify(rows);

    expect(serialised).not.toContain('super-secret-value');
    expect(serialised).not.toContain('another-secret');
    expect(serialised).not.toContain('POSTGRES_PASSWORD');

    connection.close();
  });

  /*
   * A container Dockplane built keeps its identity when Docker replaces it.
   *
   * Docker gives a replacement a new identifier. Matching on that alone would
   * delete the operator's resource and create another one — taking its address,
   * its history and everything referring to it.
   */
  describe('stable identity', () => {
    it('moves a resource to its replacement rather than replacing the resource', async () => {
      const agent = await enrollAgent();

      const first = await connectScripted(agent, [
        inventoryReply('docker-01'),
        metricsReply(),
        { capability: 'container.list', payload: { containers: [container('aaa', 'web')] } },
        { capability: 'compose.list', payload: { projects: [] } },
      ]);

      await discovery.sync(agent.agentId);
      first.close();

      const [before] = await db.client.select().from(containers);
      const resourceId = before.id;

      // The replacement: a different Docker container, the same Dockplane one.
      const second = await connectScripted(agent, [
        inventoryReply('docker-01'),
        metricsReply(),
        {
          capability: 'container.list',
          payload: { containers: [managed('bbb', 'web', resourceId)] },
        },
        { capability: 'compose.list', payload: { projects: [] } },
      ]);

      await discovery.sync(agent.agentId);
      second.close();

      const rows = await db.client.select().from(containers);

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(resourceId);
      expect(rows[0].dockerId).toBe('bbb');
      expect(rows[0].identityConflict).toBeNull();
    });

    it('refuses to guess when two containers claim one identity', async () => {
      const agent = await enrollAgent();

      const first = await connectScripted(agent, [
        inventoryReply('docker-01'),
        metricsReply(),
        { capability: 'container.list', payload: { containers: [container('aaa', 'web')] } },
        { capability: 'compose.list', payload: { projects: [] } },
      ]);

      await discovery.sync(agent.agentId);
      first.close();

      const [before] = await db.client.select().from(containers);
      const resourceId = before.id;

      // What a crash midway through a replacement would leave behind.
      const second = await connectScripted(agent, [
        inventoryReply('docker-01'),
        metricsReply(),
        {
          capability: 'container.list',
          payload: {
            containers: [
              managed('bbb', 'web', resourceId),
              managed('ccc', 'web.dockplane-old', resourceId),
            ],
          },
        },
        { capability: 'compose.list', payload: { projects: [] } },
      ]);

      await discovery.sync(agent.agentId);
      second.close();

      const [row] = await db.client.select().from(containers).where(eq(containers.id, resourceId));

      // Neither is adopted, and nothing is removed. A person decides.
      expect(row.identityConflict).not.toBeNull();
      expect(row.identityConflict?.dockerIds).toHaveLength(2);
      expect(row.dockerId).toBe('aaa');
    });

    it('leaves a container it did not build alone, whatever it is called', async () => {
      const agent = await enrollAgent();

      const first = await connectScripted(agent, [
        inventoryReply('docker-01'),
        metricsReply(),
        { capability: 'container.list', payload: { containers: [container('aaa', 'web')] } },
        { capability: 'compose.list', payload: { projects: [] } },
      ]);

      await discovery.sync(agent.agentId);
      first.close();

      const [before] = await db.client.select().from(containers);

      // Same name, no identity label: somebody else's container, not a
      // replacement. Merging them on the name would be a guess.
      const second = await connectScripted(agent, [
        inventoryReply('docker-01'),
        metricsReply(),
        { capability: 'container.list', payload: { containers: [container('zzz', 'web')] } },
        { capability: 'compose.list', payload: { projects: [] } },
      ]);

      await discovery.sync(agent.agentId);
      second.close();

      const rows = await db.client.select().from(containers);

      expect(rows).toHaveLength(1);
      expect(rows[0].dockerId).toBe('zzz');
      expect(rows[0].id).not.toBe(before.id);
    });

    it('does not move a resource a mutation is holding', async () => {
      const agent = await enrollAgent();

      const first = await connectScripted(agent, [
        inventoryReply('docker-01'),
        metricsReply(),
        { capability: 'container.list', payload: { containers: [container('aaa', 'web')] } },
        { capability: 'compose.list', payload: { projects: [] } },
      ]);

      await discovery.sync(agent.agentId);
      first.close();

      const [before] = await db.client.select().from(containers);

      // A replacement is in flight: both containers exist, and the mutation
      // decides which one the resource ends on.
      discovery.registerInFlight(new Set([before.id]));

      const second = await connectScripted(agent, [
        inventoryReply('docker-01'),
        metricsReply(),
        {
          capability: 'container.list',
          payload: {
            containers: [
              managed('bbb', 'web', before.id),
              managed('ccc', 'web.dockplane-old', before.id),
            ],
          },
        },
        { capability: 'compose.list', payload: { projects: [] } },
      ]);

      await discovery.sync(agent.agentId);
      second.close();
      discovery.registerInFlight(new Set());

      const [row] = await db.client.select().from(containers).where(eq(containers.id, before.id));

      // Untouched, and not flagged: a replacement in progress is not a conflict.
      expect(row.dockerId).toBe('aaa');
      expect(row.identityConflict).toBeNull();
    });
  });

  /*
   * Which configuration a container is running.
   *
   * Recorded from what the container says, because nothing else can say it: two
   * configurations may differ only in a secret, and this projection carries no
   * environment values at all. Everything an interrupted replacement can be
   * resolved by is in this one field, which is why it is read strictly.
   */
  describe('the configuration a container claims', () => {
    const CONFIG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    /** Discovers one managed container and returns the row it produced. */
    const observe = async (labels: Record<string, string> | undefined) => {
      const agent = await enrollAgent();

      const connection = await connectScripted(agent, [
        inventoryReply('docker-01'),
        metricsReply(),
        {
          capability: 'container.list',
          payload: { containers: [{ ...container('aaa', 'web'), labels }] },
        },
        { capability: 'compose.list', payload: { projects: [] } },
      ]);

      await discovery.sync(agent.agentId);
      connection.close();

      const [row] = await db.client.select().from(containers);

      return row;
    };

    it('records what a managed container says it is running', async () => {
      const agent = await enrollAgent();

      const first = await connectScripted(agent, [
        inventoryReply('docker-01'),
        metricsReply(),
        { capability: 'container.list', payload: { containers: [container('aaa', 'web')] } },
        { capability: 'compose.list', payload: { projects: [] } },
      ]);

      await discovery.sync(agent.agentId);
      first.close();

      const [before] = await db.client.select().from(containers);

      const second = await connectScripted(agent, [
        inventoryReply('docker-01'),
        metricsReply(),
        {
          capability: 'container.list',
          payload: { containers: [applying('aaa', 'web', before.id, CONFIG_A)] },
        },
        { capability: 'compose.list', payload: { projects: [] } },
      ]);

      await discovery.sync(agent.agentId);
      second.close();

      const [row] = await db.client.select().from(containers).where(eq(containers.id, before.id));

      expect(row.observedDesiredConfigId).toBe(CONFIG_A);
    });

    it('asks nothing of a container Dockplane did not build', async () => {
      // An unmanaged container may carry any label at all. None of them mean
      // anything here, including one that looks exactly like this.
      const row = await observe({ 'io.dockplane.desired-config-id': CONFIG_A });

      expect(row.observedDesiredConfigId).toBeNull();
    });

    it('records nothing for a managed container that carries no configuration', async () => {
      const row = await observe({
        'io.dockplane.managed': 'true',
        'io.dockplane.container-id': CONFIG_A,
      });

      expect(row.observedDesiredConfigId).toBeNull();
    });

    it('refuses a configuration identity it cannot read', async () => {
      /*
       * Storing it would put a host-written string where the control server
       * expects one of its own. Recording nothing is what makes recovery treat
       * the container as unreadable rather than as a container running some
       * configuration nobody has heard of.
       */
      for (const claimed of [
        'not-a-uuid',
        '',
        '   ',
        "'; drop table containers; --",
        CONFIG_A.slice(0, 20),
      ]) {
        const row = await observe({
          'io.dockplane.managed': 'true',
          'io.dockplane.container-id': CONFIG_A,
          'io.dockplane.desired-config-id': claimed,
        });

        expect(row.observedDesiredConfigId).toBeNull();

        await resetData(db);
        await signInAsAdmin();
      }
    });
  });
});
