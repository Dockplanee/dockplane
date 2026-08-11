import { INestApplication } from '@nestjs/common';
import * as x509 from '@peculiar/x509';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { hashSecret } from '../src/common/crypto';
import { Database } from '../src/database/database';
import { agentEnrollmentTokens, agents } from '../src/database/schema';
import {
  DEFAULT_PASSWORD,
  createTestApp,
  resetData,
  resetThrottling,
  seedUser,
  testPki,
} from './app';
import { createAgentCsr } from './agent-pki';

const ORIGIN = 'http://localhost:4200';

describe('agent enrollment', () => {
  let app: INestApplication;
  let db: Database;
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

  const createToken = async (intendedHostname?: string) => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/agents/enrollment-tokens')
      .set('cookie', adminCookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', adminCsrf)
      .send(intendedHostname ? { intendedHostname } : {});

    return response;
  };

  const enroll = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/api/v1/agent-enrollments').send(body);

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
    await signInAsAdmin();
  });

  describe('enrollment tokens', () => {
    it('requires the agents.enroll permission', async () => {
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
        .post('/api/v1/agents/enrollment-tokens')
        .set('cookie', cookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', session.body.csrfToken)
        .send({});

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('PERMISSION_DENIED');
    });

    it('returns at least 256 bits of entropy', async () => {
      const response = await createToken();

      expect(response.status).toBe(201);
      expect(Buffer.from(response.body.token, 'base64url').length).toBeGreaterThanOrEqual(32);
    });

    it('stores only the digest of the token', async () => {
      const response = await createToken();

      const [row] = await db.client.select().from(agentEnrollmentTokens);

      expect(row.tokenHash).toBe(hashSecret(response.body.token));
      expect(JSON.stringify(row)).not.toContain(response.body.token);
    });

    it('never returns the raw token again', async () => {
      const created = await createToken();

      const listed = await request(app.getHttpServer())
        .get('/api/v1/agents/enrollment-tokens')
        .set('cookie', adminCookie);

      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.body)).not.toContain(created.body.token);
      expect(listed.body.tokens[0]).not.toHaveProperty('tokenHash');
    });

    it('expires within the configured window', async () => {
      const response = await createToken();
      const lifetimeMs = new Date(response.body.expiresAt).getTime() - Date.now();

      expect(lifetimeMs).toBeGreaterThan(0);
      expect(lifetimeMs).toBeLessThanOrEqual(10 * 60 * 1000 + 5000);
    });

    it('records the creation in the audit log without the token', async () => {
      const created = await createToken('docker-01');

      const audit = await request(app.getHttpServer())
        .get('/api/v1/audit?limit=20')
        .set('cookie', adminCookie);

      const entry = audit.body.entries.find(
        (candidate: { action: string }) => candidate.action === 'agent.enrollment_token.created',
      );

      expect(entry).toBeDefined();
      expect(entry.targetLabel).toBe('docker-01');
      expect(JSON.stringify(audit.body)).not.toContain(created.body.token);
    });
  });

  describe('exchanging a token', () => {
    it('issues a certificate for a valid token', async () => {
      const token = (await createToken()).body.token;
      const { csrPem } = await createAgentCsr();

      const response = await enroll({
        token,
        csr: csrPem,
        protocolVersion: 1,
        agentVersion: '0.1.0',
        hostname: 'docker-01',
      });

      expect(response.status).toBe(201);
      expect(response.body.certificate).toContain('BEGIN CERTIFICATE');
      expect(response.body.caChain).toContain('BEGIN CERTIFICATE');
      expect(response.body.agentId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('never returns private key material', async () => {
      const token = (await createToken()).body.token;
      const { csrPem } = await createAgentCsr();

      const response = await enroll({ token, csr: csrPem, protocolVersion: 1 });

      expect(JSON.stringify(response.body)).not.toContain('PRIVATE KEY');
    });

    it('names the certificate after the server-assigned identity', async () => {
      const token = (await createToken()).body.token;
      const { csrPem } = await createAgentCsr({ commonName: 'i-choose-my-own-name' });

      const response = await enroll({ token, csr: csrPem, protocolVersion: 1 });
      const certificate = new x509.X509Certificate(response.body.certificate);

      expect(certificate.subject).toBe(`CN=${response.body.agentId}`);
      expect(certificate.subject).not.toContain('i-choose-my-own-name');
    });

    it('issues a client certificate that chains to the agent CA', async () => {
      const token = (await createToken()).body.token;
      const { csrPem } = await createAgentCsr();
      const pki = await testPki();

      const response = await enroll({ token, csr: csrPem, protocolVersion: 1 });
      const certificate = new x509.X509Certificate(response.body.certificate);
      const ca = new x509.X509Certificate(pki.caCertPem);

      expect(await certificate.verify({ publicKey: await ca.publicKey.export() })).toBe(true);

      const usage = certificate.getExtension(x509.ExtendedKeyUsageExtension);
      expect(usage?.usages).toEqual([x509.ExtendedKeyUsage.clientAuth]);

      const constraints = certificate.getExtension(x509.BasicConstraintsExtension);
      expect(constraints?.ca).toBe(false);
    });

    it('issues a certificate that expires', async () => {
      const token = (await createToken()).body.token;
      const { csrPem } = await createAgentCsr();

      const response = await enroll({ token, csr: csrPem, protocolVersion: 1 });
      const notAfter = new Date(response.body.certificateNotAfter).getTime();

      expect(notAfter).toBeGreaterThan(Date.now());
      expect(notAfter).toBeLessThanOrEqual(Date.now() + 31 * 24 * 3600 * 1000);
    });

    it('persists the certificate serial and fingerprint', async () => {
      const token = (await createToken()).body.token;
      const { csrPem } = await createAgentCsr();

      const response = await enroll({ token, csr: csrPem, protocolVersion: 1 });
      const [agent] = await db.client
        .select()
        .from(agents)
        .where(eq(agents.id, response.body.agentId));

      const certificate = new x509.X509Certificate(response.body.certificate);

      expect(agent.certificateSerial).toBe(certificate.serialNumber.toLowerCase());
      expect(agent.certificateFingerprint).toHaveLength(64);
      expect(agent.status).toBe('pending');
    });

    it('marks the token consumed and links it to the agent', async () => {
      const token = (await createToken()).body.token;
      const { csrPem } = await createAgentCsr();

      const response = await enroll({ token, csr: csrPem, protocolVersion: 1 });
      const [row] = await db.client.select().from(agentEnrollmentTokens);

      expect(row.consumedAt).not.toBeNull();
      expect(row.consumedByAgentId).toBe(response.body.agentId);
    });

    it('refuses a token that was already used', async () => {
      const token = (await createToken()).body.token;

      await enroll({ token, csr: (await createAgentCsr()).csrPem, protocolVersion: 1 });
      const second = await enroll({
        token,
        csr: (await createAgentCsr()).csrPem,
        protocolVersion: 1,
      });

      expect(second.status).toBe(401);
      expect(second.body.code).toBe('ENROLLMENT_TOKEN_CONSUMED');
    });

    it('refuses an expired token', async () => {
      const created = await createToken();

      await db.client
        .update(agentEnrollmentTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(agentEnrollmentTokens.id, created.body.id));

      const response = await enroll({
        token: created.body.token,
        csr: (await createAgentCsr()).csrPem,
        protocolVersion: 1,
      });

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('ENROLLMENT_TOKEN_EXPIRED');
    });

    it('refuses a revoked token', async () => {
      const created = await createToken();

      const revoked = await request(app.getHttpServer())
        .post(`/api/v1/agents/enrollment-tokens/${created.body.id}/revoke`)
        .set('cookie', adminCookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', adminCsrf);

      expect(revoked.status).toBe(204);

      const response = await enroll({
        token: created.body.token,
        csr: (await createAgentCsr()).csrPem,
        protocolVersion: 1,
      });

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('ENROLLMENT_TOKEN_REVOKED');
    });

    it('refuses an unknown token', async () => {
      const response = await enroll({
        token: 'a'.repeat(43),
        csr: (await createAgentCsr()).csrPem,
        protocolVersion: 1,
      });

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('ENROLLMENT_TOKEN_INVALID');
    });

    it('refuses an unsupported protocol version', async () => {
      const token = (await createToken()).body.token;

      const response = await enroll({
        token,
        csr: (await createAgentCsr()).csrPem,
        protocolVersion: 999,
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('AGENT_PROTOCOL_UNSUPPORTED');
    });

    it('lets exactly one of several concurrent requests win', async () => {
      const token = (await createToken()).body.token;

      const requests = await Promise.all(
        Array.from({ length: 5 }, async () =>
          enroll({ token, csr: (await createAgentCsr()).csrPem, protocolVersion: 1 }),
        ),
      );

      const created = requests.filter((response) => response.status === 201);
      const refused = requests.filter((response) => response.status === 401);

      expect(created).toHaveLength(1);
      expect(refused).toHaveLength(4);

      const rows = await db.client.select().from(agents);
      expect(rows).toHaveLength(1);
    });
  });

  describe('certificate request validation', () => {
    const expectRejected = async (csr: string) => {
      const token = (await createToken()).body.token;
      const response = await enroll({ token, csr, protocolVersion: 1 });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('ENROLLMENT_CSR_INVALID');

      return response;
    };

    it('refuses a request that is not PEM', async () => {
      await expectRejected('definitely not a certificate request');
    });

    it('refuses a structurally broken request', async () => {
      const { csrPem } = await createAgentCsr();
      await expectRejected(csrPem.replace(/[A-Za-z0-9+/]{24}/, 'A'.repeat(24)));
    });

    it('refuses a request asking to become a certificate authority', async () => {
      const { csrPem } = await createAgentCsr({
        extensions: [new x509.BasicConstraintsExtension(true, 5, true)],
      });

      await expectRejected(csrPem);
    });

    it('refuses a request asking for server authentication', async () => {
      const { csrPem } = await createAgentCsr({
        extensions: [new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], true)],
      });

      await expectRejected(csrPem);
    });

    it('refuses a request claiming alternative names', async () => {
      const { csrPem } = await createAgentCsr({
        extensions: [
          new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'control.internal' }]),
        ],
      });

      await expectRejected(csrPem);
    });

    it('does not consume the token when the request is rejected', async () => {
      const created = await createToken();

      const rejected = await enroll({
        token: created.body.token,
        csr: 'not a csr',
        protocolVersion: 1,
      });
      expect(rejected.status).toBe(400);

      const accepted = await enroll({
        token: created.body.token,
        csr: (await createAgentCsr()).csrPem,
        protocolVersion: 1,
      });
      expect(accepted.status).toBe(201);
    });

    it('does not echo parser internals to an unauthenticated caller', async () => {
      const response = await expectRejected(
        '-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----',
      );

      expect(response.body.message).toBe('The certificate request could not be parsed.');
    });
  });
});
