import { AddressInfo } from 'node:net';

import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { AgentGatewayService } from '../src/agents/agent-gateway.service';
import { Database } from '../src/database/database';
import { DiscoveryScheduler } from '../src/discovery/discovery.scheduler';
import { agents } from '../src/database/schema';
import { TestAgentConnection } from './agent-client';
import { createAgentCsr, createForeignAgentCertificate } from './agent-pki';
import {
  DEFAULT_PASSWORD,
  createTestApp,
  resetData,
  resetThrottling,
  seedUser,
  testPki,
} from './app';

const ORIGIN = 'http://localhost:4200';

interface EnrolledAgent {
  readonly agentId: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}

/**
 * Gateway behaviour over real TLS.
 *
 * These tests open genuine mTLS connections rather than calling the handler
 * directly. The properties under test — that a certificate is required, that it
 * must chain to the agent CA, that identity comes from the certificate — live
 * in the TLS layer and in how the server reads the verified peer, so a mocked
 * socket would prove nothing.
 */
describe('agent gateway', () => {
  let app: INestApplication;
  let db: Database;
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

  /** Runs a complete enrollment and returns usable client credentials. */
  const enrollAgent = async (hostname = 'docker-01'): Promise<EnrolledAgent> => {
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

    expect(enrolled.status).toBe(201);

    return {
      agentId: enrolled.body.agentId,
      certificatePem: enrolled.body.certificate,
      privateKeyPem,
    };
  };

  const connect = (agent: { certificatePem?: string; privateKeyPem?: string }) =>
    TestAgentConnection.open({
      port,
      caPem,
      certificatePem: agent.certificatePem,
      privateKeyPem: agent.privateKeyPem,
    });

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(Database);
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

  /**
   * The two listeners cannot end up sharing a port number.
   *
   * They speak different protocols on the same host, so a request that reaches
   * the wrong one fails in a way that looks like anything but a port problem: an
   * HTTP client reads a TLS handshake and reports a parse error.
   *
   * That is reachable whenever one of them binds a wildcard address. BSD allows
   * a wildcard socket and a `127.0.0.1` socket to hold the same port at once,
   * and a connection to `127.0.0.1` is then routed to the more specific of the
   * two. Both listeners therefore bind the loopback address explicitly, which
   * makes the operating system refuse a collision instead of allowing it.
   */
  it('binds a loopback port of its own, distinct from the API', () => {
    const api = (app.getHttpServer() as { address(): AddressInfo | string | null }).address();

    expect(port).toBeGreaterThan(0);
    expect(typeof api).toBe('object');

    const address = api as AddressInfo;

    expect(address.address).toBe('127.0.0.1');
    expect(address.port).not.toBe(port);
  });

  /**
   * Polling ends with the connection that started it.
   *
   * The server polls an agent for as long as it is connected. A schedule left
   * behind by a closed connection keeps doing database work for an agent that
   * is not there, forever, and the load lands on whatever runs next.
   */
  it('stops polling an agent once its connection closes', async () => {
    const scheduler = app.get(DiscoveryScheduler);
    const agent = await enrollAgent();
    const connection = await connect(agent);

    connection.send({ type: 'hello', protocolVersion: 1 });
    await connection.waitFor('hello_ack');

    expect(scheduler.scheduled).toBeGreaterThan(0);

    connection.close();
    await connection.waitForClose();

    const deadline = Date.now() + 5000;

    while (scheduler.scheduled > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(scheduler.scheduled).toBe(0);
  });

  /**
   * A connection a test forgot is closed for it.
   *
   * Without this the schedule above outlives the test, and the interference
   * shows up in a later suite rather than where it was caused.
   */
  it('closes a connection a test left open', async () => {
    const agent = await enrollAgent();
    const connection = await connect(agent);

    connection.send({ type: 'hello', protocolVersion: 1 });
    await connection.waitFor('hello_ack');

    TestAgentConnection.closeAll();
    await connection.waitForClose();

    expect(connection.isClosed).toBe(true);
  });

  /**
   * The suite owns the API listener for its whole life.
   *
   * Left to itself, supertest binds a fresh wildcard socket for every request
   * and closes it again afterwards — hundreds of chances per run for one of
   * them to be handed the gateway's port number.
   */
  it('keeps one API listener rather than one per request', async () => {
    const server = app.getHttpServer() as { address(): AddressInfo | string | null };
    const before = (server.address() as AddressInfo).port;

    await request(app.getHttpServer()).get('/health/live').expect(200);

    expect((server.address() as AddressInfo).port).toBe(before);
  });

  describe('transport trust', () => {
    it('accepts an enrolled agent and answers with the identity it assigned', async () => {
      const agent = await enrollAgent();
      const connection = await connect(agent);

      connection.send({ type: 'hello', protocolVersion: 1, agentVersion: '0.1.0' });
      const ack = await connection.waitFor('hello_ack');

      expect(ack.agentId).toBe(agent.agentId);
      expect(ack.protocolVersion).toBe(1);
      expect(typeof ack.heartbeatIntervalSeconds).toBe('number');

      connection.close();
    });

    /*
     * Under TLS 1.3 the client finishes its side of the handshake before the
     * server has verified the client certificate, so a rejected peer may see
     * `secureConnect` and only then be cut off. The assertion is therefore that
     * the server refuses to serve the connection, not that connect() throws.
     */
    const expectRefusedByServer = async (credentials: {
      certificatePem?: string;
      privateKeyPem?: string;
    }) => {
      let connection: TestAgentConnection;

      try {
        connection = await connect(credentials);
      } catch {
        // Rejected during the handshake, which is the strongest outcome.
        return;
      }

      connection.send({ type: 'hello', protocolVersion: 1 });
      await connection.waitForClose(5000);

      expect(connection.messages.find((message) => message.type === 'hello_ack')).toBeUndefined();
    };

    it('refuses a connection without a client certificate', async () => {
      await expectRefusedByServer({});
    });

    it('refuses a certificate issued by another authority', async () => {
      await expectRefusedByServer(await createForeignAgentCertificate());
    });

    it('refuses a certificate whose agent is unknown to the registry', async () => {
      const agent = await enrollAgent();
      // The certificate stays valid; the identity behind it disappears.
      await db.client.delete(agents).where(eq(agents.id, agent.agentId));

      const connection = await connect(agent);
      connection.send({ type: 'hello', protocolVersion: 1 });

      const error = await connection.waitFor('error');
      expect(error.code).toBe('AGENT_UNKNOWN');

      await connection.waitForClose();
    });

    it('refuses an agent whose certificate has expired', async () => {
      const agent = await enrollAgent();

      await db.client
        .update(agents)
        .set({ certificateNotAfter: new Date(Date.now() - 1000) })
        .where(eq(agents.id, agent.agentId));

      const connection = await connect(agent);
      connection.send({ type: 'hello', protocolVersion: 1 });

      const error = await connection.waitFor('error');
      expect(error.code).toBe('AGENT_CERT_EXPIRED');
    });
  });

  describe('identity', () => {
    it('ignores an agent id supplied in the payload', async () => {
      const mine = await enrollAgent('docker-01');
      const other = await enrollAgent('docker-02');

      const connection = await connect(mine);
      connection.send({
        type: 'hello',
        protocolVersion: 1,
        // A field the protocol does not define, sent to prove it is not honoured.
        agentId: other.agentId,
      });

      const ack = await connection.waitFor('hello_ack');

      expect(ack.agentId).toBe(mine.agentId);
      expect(ack.agentId).not.toBe(other.agentId);

      connection.close();
    });

    it('attributes the heartbeat to the certificate holder', async () => {
      const mine = await enrollAgent('docker-01');
      const other = await enrollAgent('docker-02');

      const connection = await connect(mine);
      connection.send({ type: 'hello', protocolVersion: 1 });
      await connection.waitFor('hello_ack');

      connection.send({ type: 'heartbeat', protocolVersion: 1, agentId: other.agentId });
      await connection.waitFor('heartbeat_ack');

      const [mineRow] = await db.client.select().from(agents).where(eq(agents.id, mine.agentId));
      const [otherRow] = await db.client.select().from(agents).where(eq(agents.id, other.agentId));

      expect(mineRow.lastSeenAt).not.toBeNull();
      expect(otherRow.lastSeenAt).toBeNull();

      connection.close();
    });
  });

  describe('protocol', () => {
    it('refuses an unsupported protocol version and closes', async () => {
      const agent = await enrollAgent();
      const connection = await connect(agent);

      connection.send({ type: 'hello', protocolVersion: 99 });

      const error = await connection.waitFor('error');
      expect(error.code).toBe('AGENT_PROTOCOL_UNSUPPORTED');

      await connection.waitForClose();
    });

    it('refuses a message that cannot be understood', async () => {
      const agent = await enrollAgent();
      const connection = await connect(agent);

      connection.sendRaw('this is not json\n');

      const error = await connection.waitFor('error');
      expect(error.code).toBe('AGENT_PROTOCOL_UNSUPPORTED');
    });

    it('answers pipelined messages in the order they were sent', async () => {
      const agent = await enrollAgent();
      const connection = await connect(agent);

      // Sent without waiting for the first reply, so both may arrive together.
      connection.send({ type: 'hello', protocolVersion: 1 });
      connection.send({ type: 'heartbeat', protocolVersion: 1 });

      await connection.waitFor('heartbeat_ack');

      expect(connection.messages.map((message) => message.type)).toEqual([
        'hello_ack',
        'heartbeat_ack',
      ]);

      connection.close();
    });

    it('requires hello before any other message', async () => {
      const agent = await enrollAgent();
      const connection = await connect(agent);

      connection.send({ type: 'heartbeat', protocolVersion: 1 });

      const error = await connection.waitFor('error');
      expect(error.code).toBe('AGENT_PROTOCOL_UNSUPPORTED');
    });

    it('refuses an oversized message and closes the connection', async () => {
      const agent = await enrollAgent();
      const connection = await connect(agent);

      // No newline, so the gateway must bound the buffer rather than wait.
      connection.sendRaw('x'.repeat(2 * 1024 * 1024));

      const error = await connection.waitFor('error', 5000);
      expect(error.code).toBe('AGENT_MESSAGE_TOO_LARGE');

      await connection.waitForClose(5000);
    });

    it('updates last seen on heartbeat and marks the agent connected', async () => {
      const agent = await enrollAgent();
      const connection = await connect(agent);

      connection.send({ type: 'hello', protocolVersion: 1 });
      await connection.waitFor('hello_ack');

      connection.send({ type: 'heartbeat', protocolVersion: 1 });
      await connection.waitFor('heartbeat_ack');

      const [row] = await db.client.select().from(agents).where(eq(agents.id, agent.agentId));

      expect(row.status).toBe('connected');
      expect(row.lastSeenAt).not.toBeNull();
      expect(row.firstSeenAt).not.toBeNull();

      connection.close();
    });

    it('carries no Docker capability in this milestone', async () => {
      const agent = await enrollAgent();
      const connection = await connect(agent);

      connection.send({ type: 'hello', protocolVersion: 1, capabilities: ['container.start'] });
      await connection.waitFor('hello_ack');

      connection.send({ type: 'container.start', protocolVersion: 1, containerId: 'abc' });

      const error = await connection.waitFor('error');
      expect(error.code).toBe('AGENT_PROTOCOL_UNSUPPORTED');

      connection.close();
    });
  });

  describe('revocation', () => {
    const revoke = (agentId: string) =>
      request(app.getHttpServer())
        .post(`/api/v1/agents/${agentId}/revoke`)
        .set('cookie', adminCookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', adminCsrf)
        .send({ reason: 'decommissioned' });

    it('closes the live connection of a revoked agent', async () => {
      const agent = await enrollAgent();
      const connection = await connect(agent);

      connection.send({ type: 'hello', protocolVersion: 1 });
      await connection.waitFor('hello_ack');

      const response = await revoke(agent.agentId);
      expect(response.status).toBe(204);

      await connection.waitForClose();
    });

    /**
     * A revoked agent is not polled again.
     *
     * Revocation drops the connection, which removes it from the registry, so
     * the socket's close handler no longer recognises it as the current one and
     * does not stop the schedule. Without stopping it at the source, the server
     * would keep reading a host it has just been told not to trust — once a
     * minute, for as long as the process runs.
     */
    it('stops polling a revoked agent', async () => {
      const scheduler = app.get(DiscoveryScheduler);
      const agent = await enrollAgent();
      const connection = await connect(agent);

      connection.send({ type: 'hello', protocolVersion: 1 });
      await connection.waitFor('hello_ack');

      expect(scheduler.scheduled).toBeGreaterThan(0);

      expect((await revoke(agent.agentId)).status).toBe(204);
      await connection.waitForClose();

      expect(scheduler.scheduled).toBe(0);
    });

    it('refuses a reconnection after revocation', async () => {
      const agent = await enrollAgent();
      await revoke(agent.agentId);

      const connection = await connect(agent);
      connection.send({ type: 'hello', protocolVersion: 1 });

      const error = await connection.waitFor('error');
      expect(error.code).toBe('AGENT_REVOKED');

      await connection.waitForClose();
    });

    it('records the revocation with its reason', async () => {
      const agent = await enrollAgent();
      await revoke(agent.agentId);

      const [row] = await db.client.select().from(agents).where(eq(agents.id, agent.agentId));

      expect(row.status).toBe('revoked');
      expect(row.revokedAt).not.toBeNull();
      expect(row.revocationReason).toBe('decommissioned');
    });

    it('requires the agents.revoke permission', async () => {
      const agent = await enrollAgent();
      const viewer = await seedUser(db, {
        email: 'viewer@example.internal',
        roleName: 'Read Only',
      });

      const session = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('origin', ORIGIN)
        .send({ email: viewer.email, password: DEFAULT_PASSWORD });

      const raw = session.headers['set-cookie'] as unknown as string[];
      const cookie = raw.find((entry) => entry.startsWith('dockplane_session='))!.split(';')[0];

      const response = await request(app.getHttpServer())
        .post(`/api/v1/agents/${agent.agentId}/revoke`)
        .set('cookie', cookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', session.body.csrfToken)
        .send({ reason: 'should not work' });

      expect(response.status).toBe(403);
    });
  });

  describe('duplicate connections', () => {
    it('replaces an earlier connection with the newest one', async () => {
      const agent = await enrollAgent();

      const first = await connect(agent);
      first.send({ type: 'hello', protocolVersion: 1 });
      await first.waitFor('hello_ack');

      const second = await connect(agent);
      second.send({ type: 'hello', protocolVersion: 1 });
      await second.waitFor('hello_ack');

      // The stale connection is dropped so a reconnecting agent is never locked
      // out by its own half-open predecessor.
      await first.waitForClose();

      second.send({ type: 'heartbeat', protocolVersion: 1 });
      await second.waitFor('heartbeat_ack');

      second.close();
    });
  });
});
