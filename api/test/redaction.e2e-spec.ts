import { INestApplication } from '@nestjs/common';
import { Writable } from 'node:stream';

import request from 'supertest';

import { REDACTED, createLogger } from '../src/logging/logger';
import { Database } from '../src/database/database';
import { auditEntries } from '../src/database/schema';
import { DEFAULT_PASSWORD, createTestApp, resetData, resetThrottling, seedUser } from './app';

const ORIGIN = 'http://localhost:4200';

/** Captures everything the production logger emits so the output can be asserted on. */
function capturingLogger() {
  const chunks: string[] = [];

  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });

  return { logger: createLogger('info', 'dockplane-api', sink), output: () => chunks.join('') };
}

describe('secret redaction', () => {
  describe('logger', () => {
    const secrets = {
      password: 'a-very-distinctive-password',
      sessionToken: 'a-very-distinctive-session-token',
      enrollmentToken: 'a-very-distinctive-enrollment-token',
      csrfToken: 'a-very-distinctive-csrf-token',
      mfaSecret: 'JBSWY3DPEHPK3PXP',
      recoveryCode: 'a-very-distinctive-recovery-code',
      privateKey: '-----BEGIN PRIVATE KEY-----AAAA-----END PRIVATE KEY-----',
    };

    it('redacts a secret logged at the top level', () => {
      const { logger, output } = capturingLogger();

      logger.info(secrets, 'attempted disclosure');

      for (const [name, value] of Object.entries(secrets)) {
        expect(output()).not.toContain(value);
        expect(`${name}: ${output()}`).toContain(REDACTED);
      }
    });

    it('redacts a secret nested in a request body', () => {
      const { logger, output } = capturingLogger();

      logger.info({ body: secrets, req: { body: secrets } }, 'attempted disclosure');

      for (const value of Object.values(secrets)) {
        expect(output()).not.toContain(value);
      }
    });

    it('redacts credential headers', () => {
      const { logger, output } = capturingLogger();

      logger.info(
        {
          req: {
            headers: {
              authorization: 'Bearer a-very-distinctive-bearer',
              cookie: 'dockplane_session=a-very-distinctive-cookie',
            },
          },
        },
        'attempted disclosure',
      );

      expect(output()).not.toContain('a-very-distinctive-bearer');
      expect(output()).not.toContain('a-very-distinctive-cookie');
    });

    it('redacts a secret attached to an error', () => {
      const { logger, output } = capturingLogger();

      logger.error({ err: { password: secrets.password } }, 'failure');

      expect(output()).not.toContain(secrets.password);
    });

    it('still emits the surrounding context', () => {
      const { logger, output } = capturingLogger();

      logger.info({ event: 'login', password: secrets.password }, 'signed in');

      expect(output()).toContain('"event":"login"');
      expect(output()).not.toContain(secrets.password);
    });
  });

  describe('audit log', () => {
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
      // Login is throttled per address, and the counter outlives resetData.
      resetThrottling(app);
    });

    it('records a sign-in without any credential material', async () => {
      const user = await seedUser(db, {
        email: 'audited@example.internal',
        roleName: 'Administrator',
      });

      const failed = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('origin', ORIGIN)
        .send({ email: user.email, password: 'the-wrong-password-value' });

      expect(failed.status).toBe(401);

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('origin', ORIGIN)
        .send({ email: user.email, password: DEFAULT_PASSWORD });

      const raw = response.headers['set-cookie'] as unknown as string[];
      const token = raw.find((entry) => entry.startsWith('dockplane_session='))!.split('=')[1];
      const csrf = response.body.csrfToken as string;

      const entries = await db.client.select().from(auditEntries);
      const serialised = JSON.stringify(entries);

      expect(entries.length).toBeGreaterThanOrEqual(2);
      expect(serialised).not.toContain(DEFAULT_PASSWORD);
      expect(serialised).not.toContain('the-wrong-password-value');
      expect(serialised).not.toContain(token);
      expect(serialised).not.toContain(csrf);
    });

    it('records a failed sign-in with a reason code rather than the attempt', async () => {
      const user = await seedUser(db, { email: 'reason@example.internal' });

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('origin', ORIGIN)
        .send({ email: user.email, password: 'another-wrong-password' });

      const [entry] = await db.client.select().from(auditEntries);

      expect(entry.action).toBe('auth.login.failed');
      expect(entry.result).toBe('failure');
      expect(entry.reasonCode).toBe('invalid_password');
      expect(JSON.stringify(entry)).not.toContain('another-wrong-password');
    });

    it('never returns credential columns through the audit endpoint', async () => {
      const admin = await seedUser(db, {
        email: 'reader@example.internal',
        roleName: 'Administrator',
      });

      const session = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('origin', ORIGIN)
        .send({ email: admin.email, password: DEFAULT_PASSWORD });

      const raw = session.headers['set-cookie'] as unknown as string[];
      const cookie = raw.find((entry) => entry.startsWith('dockplane_session='))!.split(';')[0];

      const response = await request(app.getHttpServer())
        .get('/api/v1/audit')
        .set('cookie', cookie);

      const serialised = JSON.stringify(response.body);

      expect(response.status).toBe(200);
      for (const forbidden of [
        'passwordHash',
        'tokenHash',
        'csrfTokenHash',
        'codeHash',
        'mfaSecret',
      ]) {
        expect(serialised).not.toContain(forbidden);
      }
    });
  });
});
