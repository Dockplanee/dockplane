import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AgentDispatchService } from '../src/agents/agent-dispatch.service';
import { AgentGatewayService } from '../src/agents/agent-gateway.service';
import { Database } from '../src/database/database';
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

/**
 * Capability dispatch over the live connection.
 *
 * The properties under test are about correlation and trust, so the tests use
 * real connections: a reply is only accepted from the connection that made the
 * request, for the capability it asked about, exactly once.
 */
describe('capability dispatch', () => {
  let app: INestApplication;
  let db: Database;
  let dispatch: AgentDispatchService;
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

  const connect = async (agent: { certificatePem: string; privateKeyPem: string }) => {
    const connection = await TestAgentConnection.open({ port, caPem, ...agent });

    connection.send({ type: 'hello', protocolVersion: 1 });
    await connection.waitFor('hello_ack');

    return connection;
  };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(Database);
    dispatch = app.get(AgentDispatchService);
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

  it('delivers a request and resolves it with the agent reply', async () => {
    const agent = await enrollAgent();
    const connection = await connect(agent);

    const pending = dispatch.request(agent.agentId, 'container.list');
    const received = await connection.waitFor('request');

    expect(received.capability).toBe('container.list');
    expect(typeof received.id).toBe('string');
    expect(new Date(String(received.expiresAt)).getTime()).toBeGreaterThan(Date.now());

    connection.send({
      type: 'response',
      protocolVersion: 1,
      id: received.id,
      capability: 'container.list',
      status: 'success',
      payload: { containers: [] },
    });

    await expect(pending).resolves.toEqual({ containers: [] });

    connection.close();
  });

  it('reports a failure the agent describes', async () => {
    const agent = await enrollAgent();
    const connection = await connect(agent);

    const pending = dispatch.request(agent.agentId, 'container.list');
    const received = await connection.waitFor('request');

    connection.send({
      type: 'response',
      protocolVersion: 1,
      id: received.id,
      capability: 'container.list',
      status: 'error',
      error: { code: 'DOCKER_UNAVAILABLE', message: 'The Docker socket could not be reached.' },
    });

    await expect(pending).rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });

    connection.close();
  });

  /*
   * The code comes from the agent; the sentence does not.
   *
   * An agent's error text is written for a log — it arrives wrapped in every
   * layer it passed through — and a host that had been tampered with could
   * otherwise put any sentence it liked in front of an operator.
   */
  it('does not let an agent choose the sentence an operator reads', async () => {
    const agent = await enrollAgent();
    const connection = await connect(agent);

    const pending = dispatch.request(agent.agentId, 'container.list');
    const received = await connection.waitFor('request');

    connection.send({
      type: 'response',
      protocolVersion: 1,
      id: received.id,
      capability: 'container.list',
      status: 'error',
      error: {
        code: 'DOCKER_UNAVAILABLE',
        message: 'Your session has expired. Sign in again at https://not-dockplane.example/',
      },
    });

    await expect(pending).rejects.toMatchObject({
      code: 'DOCKER_UNAVAILABLE',
      message: 'The Docker Engine on this host could not be reached.',
    });

    connection.close();
  });

  it('does not let an agent invent an error code of its own', async () => {
    const agent = await enrollAgent();
    const connection = await connect(agent);

    const pending = dispatch.request(agent.agentId, 'container.list');
    const received = await connection.waitFor('request');

    connection.send({
      type: 'response',
      protocolVersion: 1,
      id: received.id,
      capability: 'container.list',
      status: 'error',
      error: { code: 'SESSION_EXPIRED', message: 'not the agent’s to claim' },
    });

    await expect(pending).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_FAILED' });

    connection.close();
  });

  it('refuses a reply that answers a different capability', async () => {
    const agent = await enrollAgent();
    const connection = await connect(agent);

    const pending = dispatch.request(agent.agentId, 'container.list');
    const received = await connection.waitFor('request');

    connection.send({
      type: 'response',
      protocolVersion: 1,
      id: received.id,
      // A valid identifier, but an answer to a question that was not asked.
      capability: 'host.inventory',
      status: 'success',
      payload: { hostname: 'somewhere-else' },
    });

    await expect(pending).rejects.toMatchObject({ code: 'AGENT_RESPONSE_INVALID' });

    connection.close();
  });

  it('refuses a duplicate reply and closes the connection', async () => {
    const agent = await enrollAgent();
    const connection = await connect(agent);

    const pending = dispatch.request(agent.agentId, 'container.list');
    const received = await connection.waitFor('request');

    const reply = {
      type: 'response',
      protocolVersion: 1,
      id: received.id,
      capability: 'container.list',
      status: 'success',
      payload: { containers: [] },
    };

    connection.send(reply);
    await expect(pending).resolves.toEqual({ containers: [] });

    connection.send(reply);

    const error = await connection.waitFor('error');
    expect(error.code).toBe('AGENT_RESPONSE_INVALID');
  });

  it('refuses a reply to a request that was never made', async () => {
    const agent = await enrollAgent();
    const connection = await connect(agent);

    connection.send({
      type: 'response',
      protocolVersion: 1,
      id: '00000000-0000-4000-8000-000000000000',
      capability: 'container.list',
      status: 'success',
      payload: { containers: [] },
    });

    const error = await connection.waitFor('error');
    expect(error.code).toBe('AGENT_RESPONSE_INVALID');
  });

  it('refuses a reply before the handshake', async () => {
    const agent = await enrollAgent();
    const connection = await TestAgentConnection.open({ port, caPem, ...agent });

    connection.send({
      type: 'response',
      protocolVersion: 1,
      id: '00000000-0000-4000-8000-000000000000',
      capability: 'container.list',
      status: 'success',
    });

    const error = await connection.waitFor('error');
    expect(error.code).toBe('AGENT_PROTOCOL_UNSUPPORTED');
  });

  /**
   * The property that makes reconnection safe.
   *
   * A reply arriving on a replaced connection must never satisfy a request that
   * belongs to the new one, or one host's answer would be read as another's.
   */
  it('does not let a replaced connection answer for its successor', async () => {
    const agent = await enrollAgent();
    const first = await connect(agent);

    const abandoned = dispatch.request(agent.agentId, 'container.list');
    const received = await first.waitFor('request');

    // The agent reconnects; the gateway replaces the earlier connection.
    const second = await connect(agent);

    await expect(abandoned).rejects.toMatchObject({ code: 'AGENT_NOT_CONNECTED' });

    const pending = dispatch.request(agent.agentId, 'container.list');
    const fresh = await second.waitFor('request');

    expect(fresh.id).not.toBe(received.id);

    second.send({
      type: 'response',
      protocolVersion: 1,
      id: fresh.id,
      capability: 'container.list',
      status: 'success',
      payload: { containers: [] },
    });

    await expect(pending).resolves.toEqual({ containers: [] });

    second.close();
  });

  it('fails outstanding requests when the connection closes', async () => {
    const agent = await enrollAgent();
    const connection = await connect(agent);

    const pending = dispatch.request(agent.agentId, 'container.list');
    await connection.waitFor('request');

    connection.close();

    await expect(pending).rejects.toMatchObject({ code: 'AGENT_NOT_CONNECTED' });
  });

  it('refuses to dispatch to an agent that is not connected', async () => {
    const agent = await enrollAgent();

    await expect(dispatch.request(agent.agentId, 'container.list')).rejects.toMatchObject({
      code: 'AGENT_NOT_CONNECTED',
    });
  });

  it('keeps several outstanding requests correlated', async () => {
    const agent = await enrollAgent();
    const connection = await connect(agent);

    const inventory = dispatch.request(agent.agentId, 'host.inventory');
    const containers = dispatch.request(agent.agentId, 'container.list');

    const requests = await connection.waitForAll('request', 2);
    const inventoryRequest = requests.find((item) => item.capability === 'host.inventory')!;
    const containerRequest = requests.find((item) => item.capability === 'container.list')!;

    // Answered in the opposite order, so correlation cannot be by arrival.
    connection.send({
      type: 'response',
      protocolVersion: 1,
      id: containerRequest.id,
      capability: 'container.list',
      status: 'success',
      payload: { containers: ['second'] },
    });

    connection.send({
      type: 'response',
      protocolVersion: 1,
      id: inventoryRequest.id,
      capability: 'host.inventory',
      status: 'success',
      payload: { hostname: 'first' },
    });

    await expect(inventory).resolves.toEqual({ hostname: 'first' });
    await expect(containers).resolves.toEqual({ containers: ['second'] });

    connection.close();
  });
});
