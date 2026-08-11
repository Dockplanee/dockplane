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
});
