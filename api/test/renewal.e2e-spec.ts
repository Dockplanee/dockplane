import { INestApplication } from '@nestjs/common';
import * as x509 from '@peculiar/x509';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { AgentGatewayService } from '../src/agents/agent-gateway.service';
import { Database } from '../src/database/database';
import { agents, auditEntries } from '../src/database/schema';
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
 * Certificate renewal.
 *
 * Renewal never accepts an enrollment token. The proof of identity is the
 * certificate that authenticated the connection the request arrives on, so a
 * rotation cannot be used to obtain a first credential or a different one.
 */
describe('certificate renewal', () => {
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

  const connectAndHello = async (agent: {
    certificatePem: string;
    privateKeyPem: string;
  }): Promise<TestAgentConnection> => {
    const connection = await TestAgentConnection.open({ port, caPem, ...agent });

    connection.send({ type: 'hello', protocolVersion: 1 });
    await connection.waitFor('hello_ack');

    return connection;
  };

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

  it('issues a replacement certificate over the authenticated connection', async () => {
    const agent = await enrollAgent();
    const connection = await connectAndHello(agent);

    const { csrPem } = await createAgentCsr();
    connection.send({ type: 'certificate.renew', protocolVersion: 1, csr: csrPem });

    const renewed = await connection.waitFor('certificate.renewed');

    expect(String(renewed.certificate)).toContain('BEGIN CERTIFICATE');
    expect(new Date(String(renewed.certificateNotAfter)).getTime()).toBeGreaterThan(Date.now());

    connection.close();
  });

  it('states when the agent should renew rather than leaving it to decide', async () => {
    const agent = await enrollAgent();
    const connection = await connectAndHello(agent);

    const ack = await connection.waitFor('hello_ack');
    const notAfter = new Date(String(ack.certificateNotAfter)).getTime();
    const renewAfter = new Date(String(ack.renewAfter)).getTime();

    // The default policy is a 30 day certificate renewed 7 days before expiry.
    expect(notAfter - renewAfter).toBe(7 * 24 * 60 * 60 * 1000);
    expect(renewAfter).toBeGreaterThan(Date.now());

    connection.close();
  });

  it('keeps the same agent identity across renewal', async () => {
    const agent = await enrollAgent();
    const connection = await connectAndHello(agent);

    const { csrPem } = await createAgentCsr({ commonName: 'someone-else-entirely' });
    connection.send({ type: 'certificate.renew', protocolVersion: 1, csr: csrPem });

    const renewed = await connection.waitFor('certificate.renewed');
    const certificate = new x509.X509Certificate(String(renewed.certificate));

    expect(certificate.subject).toBe(`CN=${agent.agentId}`);

    connection.close();
  });

  it('records the new certificate as the identity of record', async () => {
    const agent = await enrollAgent();
    const connection = await connectAndHello(agent);

    const [before] = await db.client.select().from(agents).where(eq(agents.id, agent.agentId));

    const { csrPem } = await createAgentCsr();
    connection.send({ type: 'certificate.renew', protocolVersion: 1, csr: csrPem });
    await connection.waitFor('certificate.renewed');

    const [after] = await db.client.select().from(agents).where(eq(agents.id, agent.agentId));

    expect(after.certificateFingerprint).not.toBe(before.certificateFingerprint);
    expect(after.certificateSerial).not.toBe(before.certificateSerial);
    expect(after.id).toBe(before.id);

    connection.close();
  });

  it('lets the agent connect with the renewed certificate', async () => {
    const agent = await enrollAgent();
    const connection = await connectAndHello(agent);

    const { csrPem, privateKeyPem } = await createAgentCsr();
    connection.send({ type: 'certificate.renew', protocolVersion: 1, csr: csrPem });
    const renewed = await connection.waitFor('certificate.renewed');
    connection.close();

    const next = await connectAndHello({
      certificatePem: String(renewed.certificate),
      privateKeyPem,
    });

    const ack = await next.waitFor('hello_ack');
    expect(ack.agentId).toBe(agent.agentId);

    next.close();
  });

  it('stops accepting the superseded certificate', async () => {
    const agent = await enrollAgent();
    const connection = await connectAndHello(agent);

    const { csrPem } = await createAgentCsr();
    connection.send({ type: 'certificate.renew', protocolVersion: 1, csr: csrPem });
    await connection.waitFor('certificate.renewed');
    connection.close();

    // The registry now recognises only the replacement, so the old certificate
    // no longer maps to an identity even though it is still cryptographically
    // valid and still chains to the agent CA.
    const stale = await TestAgentConnection.open({ port, caPem, ...agent });
    stale.send({ type: 'hello', protocolVersion: 1 });

    const error = await stale.waitFor('error');
    expect(error.code).toBe('AGENT_UNKNOWN');
  });

  it('refuses a malformed certificate request', async () => {
    const agent = await enrollAgent();
    const connection = await connectAndHello(agent);

    connection.send({ type: 'certificate.renew', protocolVersion: 1, csr: 'not a csr' });

    const error = await connection.waitFor('error');
    expect(error.code).toBe('ENROLLMENT_CSR_INVALID');

    connection.close();
  });

  it('refuses a request that asks to become a certificate authority', async () => {
    const agent = await enrollAgent();
    const connection = await connectAndHello(agent);

    const { csrPem } = await createAgentCsr({
      extensions: [new x509.BasicConstraintsExtension(true, 2, true)],
    });

    connection.send({ type: 'certificate.renew', protocolVersion: 1, csr: csrPem });

    const error = await connection.waitFor('error');
    expect(error.code).toBe('ENROLLMENT_CSR_INVALID');

    connection.close();
  });

  it('refuses renewal for a revoked agent', async () => {
    const agent = await enrollAgent();
    const connection = await connectAndHello(agent);

    await request(app.getHttpServer())
      .post(`/api/v1/agents/${agent.agentId}/revoke`)
      .set('cookie', adminCookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', adminCsrf)
      .send({ reason: 'decommissioned' });

    await connection.waitForClose();

    // A revoked agent cannot reconnect, so it cannot reach renewal at all.
    const retry = await TestAgentConnection.open({ port, caPem, ...agent });
    retry.send({ type: 'hello', protocolVersion: 1 });

    const helloError = await retry.waitFor('error');
    expect(helloError.code).toBe('AGENT_REVOKED');

    const { csrPem } = await createAgentCsr();
    const direct = await TestAgentConnection.open({ port, caPem, ...agent });
    direct.send({ type: 'certificate.renew', protocolVersion: 1, csr: csrPem });

    const renewError = await direct.waitFor('error');
    expect(renewError.code).toBe('AGENT_REVOKED');

    const [row] = await db.client.select().from(agents).where(eq(agents.id, agent.agentId));
    expect(row.revokedAt).not.toBeNull();
  });

  it('requires hello before renewal', async () => {
    const agent = await enrollAgent();
    const connection = await TestAgentConnection.open({ port, caPem, ...agent });

    const { csrPem } = await createAgentCsr();
    connection.send({ type: 'certificate.renew', protocolVersion: 1, csr: csrPem });

    const error = await connection.waitFor('error');
    expect(error.code).toBe('AGENT_PROTOCOL_UNSUPPORTED');
  });

  it('records the renewal in the audit log without key material', async () => {
    const agent = await enrollAgent();
    const connection = await connectAndHello(agent);

    const { csrPem } = await createAgentCsr();
    connection.send({ type: 'certificate.renew', protocolVersion: 1, csr: csrPem });
    await connection.waitFor('certificate.renewed');

    const entries = await db.client
      .select()
      .from(auditEntries)
      .where(eq(auditEntries.action, 'agent.certificate.renewed'));

    expect(entries).toHaveLength(1);
    expect(entries[0].targetId).toBe(agent.agentId);

    const serialised = JSON.stringify(entries);
    expect(serialised).not.toContain('PRIVATE KEY');
    expect(serialised).not.toContain('CERTIFICATE REQUEST');

    connection.close();
  });
});
