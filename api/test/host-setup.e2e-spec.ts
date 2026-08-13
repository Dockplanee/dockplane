import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { hashSecret } from '../src/common/crypto';
import { Database } from '../src/database/database';
import { agentEnrollmentTokens, auditEntries, hostSetups } from '../src/database/schema';
import { createAgentCsr } from './agent-pki';
import { DEFAULT_PASSWORD, createTestApp, resetData, resetThrottling, seedUser } from './app';

const ORIGIN = 'http://localhost:4200';

/**
 * Adding a host.
 *
 * The interesting behaviour is almost all negative: what a spent ticket cannot
 * do, what a cancelled one cannot do, what an unauthorised caller cannot see,
 * and what never reaches the database, the audit trail or the visible command.
 */
describe('host setup', () => {
  let app: INestApplication;
  let db: Database;
  let adminCookie: string;
  let adminCsrf: string;

  const signIn = async (roleName: string) => {
    const user = await seedUser(db, {
      email: `${roleName.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.round(
        Math.random() * 1e6,
      )}@example.internal`,
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

  const createSetup = (displayName?: string) =>
    request(app.getHttpServer())
      .post('/api/v1/host-setups')
      .set('cookie', adminCookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', adminCsrf)
      .send(displayName ? { displayName } : {});

  const bootstrap = (ticket: string) =>
    request(app.getHttpServer()).post('/api/v1/host-setups/bootstrap').send({ ticket });

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
    const admin = await signIn('Administrator');
    adminCookie = admin.cookie;
    adminCsrf = admin.csrf;
  });

  describe('the ticket', () => {
    it('carries at least 256 bits of randomness', async () => {
      const response = await createSetup();

      expect(response.status).toBe(201);

      // base64url of 32 random bytes, so at least 43 characters and no padding.
      expect(response.body.ticket).toMatch(/^[A-Za-z0-9_-]{43,}$/);
      expect(Buffer.from(response.body.ticket, 'base64url').length).toBeGreaterThanOrEqual(32);
    });

    it('is never two the same', async () => {
      const first = await createSetup();
      const second = await createSetup();

      expect(first.body.ticket).not.toBe(second.body.ticket);
    });

    it('is stored only as a digest', async () => {
      const response = await createSetup();
      const ticket: string = response.body.ticket;

      const [row] = await db.client
        .select()
        .from(hostSetups)
        .where(eq(hostSetups.id, response.body.id));

      expect(row.ticketHash).toBe(hashSecret(ticket));
      expect(JSON.stringify(row)).not.toContain(ticket);
    });

    it('is never returned again', async () => {
      const created = await createSetup();

      const read = await request(app.getHttpServer())
        .get(`/api/v1/host-setups/${created.body.id}`)
        .set('cookie', adminCookie)
        .set('origin', ORIGIN);

      expect(read.status).toBe(200);
      expect(read.body.ticket).toBeUndefined();
      expect(JSON.stringify(read.body)).not.toContain(created.body.ticket);
    });

    it('expires', async () => {
      const created = await createSetup();

      await db.client
        .update(hostSetups)
        .set({ ticketExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(hostSetups.id, created.body.id));

      const response = await bootstrap(created.body.ticket);

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('HOST_SETUP_TICKET_INVALID');
    });

    it('cannot be spent twice', async () => {
      const created = await createSetup();

      expect((await bootstrap(created.body.ticket)).status).toBe(200);

      const second = await bootstrap(created.body.ticket);

      expect(second.status).toBe(401);
      expect(second.body.code).toBe('HOST_SETUP_TICKET_INVALID');
    });

    it('is spent exactly once under concurrent use', async () => {
      const created = await createSetup();

      const responses = await Promise.all(
        Array.from({ length: 6 }, () => bootstrap(created.body.ticket)),
      );

      expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
      expect(responses.filter((response) => response.status === 401)).toHaveLength(5);

      // One claim means one enrollment token, not six.
      const tokens = await db.client.select().from(agentEnrollmentTokens);

      expect(tokens).toHaveLength(1);
    });

    it('is refused after the setup is cancelled', async () => {
      const created = await createSetup();

      await request(app.getHttpServer())
        .post(`/api/v1/host-setups/${created.body.id}/cancel`)
        .set('cookie', adminCookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', adminCsrf)
        .expect(201);

      expect((await bootstrap(created.body.ticket)).status).toBe(401);
    });

    it('is refused once it has been regenerated', async () => {
      const created = await createSetup();

      const regenerated = await request(app.getHttpServer())
        .post(`/api/v1/host-setups/${created.body.id}/regenerate`)
        .set('cookie', adminCookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', adminCsrf);

      expect(regenerated.status).toBe(201);
      expect(regenerated.body.ticket).not.toBe(created.body.ticket);

      expect((await bootstrap(created.body.ticket)).status).toBe(401);
      expect((await bootstrap(regenerated.body.ticket)).status).toBe(200);
    });

    it('cannot be regenerated once it has been used', async () => {
      const created = await createSetup();

      await bootstrap(created.body.ticket).expect(200);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/host-setups/${created.body.id}/regenerate`)
        .set('cookie', adminCookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', adminCsrf);

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('HOST_SETUP_NOT_PENDING');
    });

    it('says the same thing however it is invalid', async () => {
      const unknown = await bootstrap('a'.repeat(43));
      const created = await createSetup();
      await bootstrap(created.body.ticket);
      const spent = await bootstrap(created.body.ticket);

      expect(unknown.status).toBe(spent.status);
      expect(unknown.body.code).toBe(spent.body.code);
      expect(unknown.body.message).toBe(spent.body.message);
    });
  });

  describe('the bootstrap response', () => {
    it('is a shell script that is never stored', async () => {
      const created = await createSetup();
      const response = await bootstrap(created.body.ticket);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/x-shellscript');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });

    it('never contains the bootstrap ticket', async () => {
      const created = await createSetup();
      const response = await bootstrap(created.body.ticket);

      expect(response.text).not.toContain(created.body.ticket);
    });

    it('passes the enrollment token on standard input and never as an argument', async () => {
      const created = await createSetup();
      const response = await bootstrap(created.body.ticket);

      const [token] = await db.client.select().from(agentEnrollmentTokens);

      expect(token).toBeDefined();
      expect(response.text).toContain('--token-stdin');
      expect(response.text).not.toContain('--token ');
      expect(response.text).not.toMatch(/DOCKPLANE_ENROLLMENT_TOKEN=/);
    });

    it('pins one agent version and never asks for the newest', async () => {
      const created = await createSetup();
      const response = await bootstrap(created.body.ticket);

      expect(response.text).toMatch(/AGENT_VERSION='[0-9]+\.[0-9]+\.[0-9]+/);
      expect(response.text).not.toContain('latest');
    });

    it('verifies a checksum before it installs anything', async () => {
      const created = await createSetup();
      const response = await bootstrap(created.body.ticket);

      const checksum = response.text.indexOf('sha256sum');
      const install = response.text.indexOf('dpkg -i');

      expect(checksum).toBeGreaterThan(-1);
      expect(install).toBeGreaterThan(checksum);
      expect(response.text).toContain('checksum mismatch');
    });

    it('refuses to run on a host that is already enrolled', async () => {
      const created = await createSetup();
      const response = await bootstrap(created.body.ticket);

      expect(response.text).toContain('already enrolled');
    });
  });

  describe('authorisation', () => {
    it('refuses a caller with no session', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/host-setups')
        .set('origin', ORIGIN)
        .send({});

      expect(response.status).toBe(401);
    });

    it('refuses a user without the enrollment permission', async () => {
      const operator = await signIn('Operator');

      const create = await request(app.getHttpServer())
        .post('/api/v1/host-setups')
        .set('cookie', operator.cookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', operator.csrf)
        .send({});

      expect(create.status).toBe(403);
    });

    it('does not let an unauthorised user read a ticket or regenerate one', async () => {
      const created = await createSetup();
      const operator = await signIn('Operator');

      const read = await request(app.getHttpServer())
        .get(`/api/v1/host-setups/${created.body.id}`)
        .set('cookie', operator.cookie)
        .set('origin', ORIGIN);

      const regenerate = await request(app.getHttpServer())
        .post(`/api/v1/host-setups/${created.body.id}/regenerate`)
        .set('cookie', operator.cookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', operator.csrf)
        .send({});

      expect(read.status).toBe(403);
      expect(regenerate.status).toBe(403);
    });

    it('rate limits the bootstrap endpoint', async () => {
      const responses = [];

      for (let attempt = 0; attempt < 12; attempt += 1) {
        responses.push(await bootstrap('b'.repeat(43)));
      }

      expect(responses.some((response) => response.status === 429)).toBe(true);
    });
  });

  describe('the audit trail', () => {
    it('records what happened and none of the material it produced', async () => {
      const created = await createSetup('web-01');
      await bootstrap(created.body.ticket);

      const entries = await db.client.select().from(auditEntries);
      const actions = entries.map((entry) => entry.action);

      expect(actions).toContain('host.setup.created');
      expect(actions).toContain('host.setup.bootstrapped');

      const serialised = JSON.stringify(entries);

      expect(serialised).not.toContain(created.body.ticket);
      expect(serialised).toContain('web-01');

      const [token] = await db.client.select().from(agentEnrollmentTokens);
      expect(serialised).not.toContain(token.tokenHash);
    });

    it('records a cancellation and a regeneration', async () => {
      const first = await createSetup();
      await request(app.getHttpServer())
        .post(`/api/v1/host-setups/${first.body.id}/regenerate`)
        .set('cookie', adminCookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', adminCsrf);
      await request(app.getHttpServer())
        .post(`/api/v1/host-setups/${first.body.id}/cancel`)
        .set('cookie', adminCookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', adminCsrf);

      const actions = (await db.client.select().from(auditEntries)).map((entry) => entry.action);

      expect(actions).toContain('host.setup.regenerated');
      expect(actions).toContain('host.setup.cancelled');
    });
  });

  describe('the state an operator sees', () => {
    it('starts as waiting and becomes installing when the command is run', async () => {
      const created = await createSetup();

      expect(created.body.status).toBe('waiting');
      expect(created.body.progress).toEqual({
        bootstrapped: false,
        enrolled: false,
        connected: false,
        inventoryReported: false,
      });

      await bootstrap(created.body.ticket);

      const read = await request(app.getHttpServer())
        .get(`/api/v1/host-setups/${created.body.id}`)
        .set('cookie', adminCookie)
        .set('origin', ORIGIN);

      expect(read.body.status).toBe('installing');
      expect(read.body.progress.bootstrapped).toBe(true);
      expect(read.body.progress.enrolled).toBe(false);
    });

    it('reports expired rather than waiting once the ticket is stale', async () => {
      const created = await createSetup();

      await db.client
        .update(hostSetups)
        .set({ ticketExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(hostSetups.id, created.body.id));

      const read = await request(app.getHttpServer())
        .get(`/api/v1/host-setups/${created.body.id}`)
        .set('cookie', adminCookie)
        .set('origin', ORIGIN);

      expect(read.body.status).toBe('expired');
    });

    it('follows the enrollment through to the agent it produced', async () => {
      const created = await createSetup('web-01');
      const bootstrapped = await bootstrap(created.body.ticket);

      expect(bootstrapped.status).toBe(200);

      // The agent does what the script would have done: it exchanges the token
      // this bootstrap minted for a certificate.
      const [token] = await db.client.select().from(agentEnrollmentTokens);
      const raw = tokenFromScript(bootstrapped.text);
      expect(hashSecret(raw)).toBe(token.tokenHash);

      const csr = await createAgentCsr();

      const enrolled = await request(app.getHttpServer())
        .post('/api/v1/agent-enrollments')
        .send({ token: raw, csr: csr.csrPem, protocolVersion: 1, hostname: 'web-01.internal' });

      expect(enrolled.status).toBe(201);

      const read = await request(app.getHttpServer())
        .get(`/api/v1/host-setups/${created.body.id}`)
        .set('cookie', adminCookie)
        .set('origin', ORIGIN);

      expect(read.body.progress.enrolled).toBe(true);
      expect(read.body.agentId).toBe(enrolled.body.agentId);
      // Enrolled is not connected, and the status says so rather than guessing.
      expect(read.body.status).toBe('installing');
    });
  });
});

/**
 * Recovers the enrollment token from a rendered script.
 *
 * Only a test does this. The token exists in that response and in the digest
 * column, and nowhere else.
 */
function tokenFromScript(script: string): string {
  const match = script.match(/printf '%s' '([A-Za-z0-9_-]+)'/);

  if (!match) {
    throw new Error('the install script does not carry an enrollment token');
  }

  return match[1];
}
