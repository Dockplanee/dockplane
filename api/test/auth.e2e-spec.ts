import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { Database } from '../src/database/database';
import { sessions, users } from '../src/database/schema';
import { hashSecret } from '../src/common/crypto';
import { DEFAULT_PASSWORD, createTestApp, resetData, seedUser } from './app';

const ORIGIN = 'http://localhost:4200';

interface LoginResult {
  status: number;
  body: { status?: string; csrfToken?: string; code?: string };
  cookie?: string;
}

describe('authentication', () => {
  let app: INestApplication;
  let db: Database;

  const login = async (email: string, password: string): Promise<LoginResult> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('origin', ORIGIN)
      .send({ email, password });

    const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
    const cookie = raw?.find((entry) => entry.startsWith('dockplane_session='))?.split(';')[0];

    return { status: response.status, body: response.body, cookie };
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
  });

  describe('login', () => {
    it('accepts correct credentials and sets a session cookie', async () => {
      const user = await seedUser(db, { email: 'ok@example.internal', roleName: 'Administrator' });
      const result = await login(user.email, DEFAULT_PASSWORD);

      expect(result.status).toBe(200);
      expect(result.body.status).toBe('authenticated');
      expect(result.cookie).toBeDefined();
    });

    it('marks the session cookie HttpOnly and scoped', async () => {
      const user = await seedUser(db, { email: 'flags@example.internal' });

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('origin', ORIGIN)
        .send({ email: user.email, password: DEFAULT_PASSWORD });

      const raw = response.headers['set-cookie'] as unknown as string[];
      const cookie = raw.find((entry) => entry.startsWith('dockplane_session='))!;

      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
    });

    it('rejects a wrong password', async () => {
      const user = await seedUser(db, { email: 'wrong@example.internal' });
      const result = await login(user.email, 'not-the-password');

      expect(result.status).toBe(401);
      expect(result.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    });

    it('answers an unknown account exactly like a wrong password', async () => {
      await seedUser(db, { email: 'known@example.internal' });

      const unknown = await login('nobody@example.internal', 'whatever-password');
      const wrong = await login('known@example.internal', 'whatever-password');

      expect(unknown.status).toBe(wrong.status);
      expect(unknown.body.code).toBe(wrong.body.code);
      expect(unknown.body).not.toHaveProperty('detail');
    });

    it('refuses a deactivated account without saying so', async () => {
      const user = await seedUser(db, { email: 'inactive@example.internal', isActive: false });
      const result = await login(user.email, DEFAULT_PASSWORD);

      expect(result.status).toBe(401);
      expect(result.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    });

    it('stores only a digest of the session token', async () => {
      const user = await seedUser(db, { email: 'digest@example.internal' });
      const result = await login(user.email, DEFAULT_PASSWORD);
      const token = result.cookie!.split('=')[1];

      const [row] = await db.client
        .select()
        .from(sessions)
        .where(eq(sessions.userId, user.id))
        .limit(1);

      expect(row.tokenHash).toBe(hashSecret(token));
      expect(JSON.stringify(row)).not.toContain(token);
    });

    it('rate limits repeated attempts against one account', async () => {
      const user = await seedUser(db, { email: 'throttled@example.internal' });

      const attempts = [];
      for (let index = 0; index < 12; index += 1) {
        attempts.push(await login(user.email, 'still-not-the-password'));
      }

      expect(attempts.some((attempt) => attempt.status === 429)).toBe(true);
    });
  });

  describe('session lifetime', () => {
    it('serves the current user for a valid session', async () => {
      const user = await seedUser(db, { email: 'me@example.internal', roleName: 'Read Only' });
      const result = await login(user.email, DEFAULT_PASSWORD);

      const response = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('cookie', result.cookie!);

      expect(response.status).toBe(200);
      expect(response.body.user.email).toBe(user.email);
      expect(response.body.roles).toEqual(['Read Only']);
    });

    it('refuses a request without a session', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/auth/me');

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('SESSION_REQUIRED');
    });

    it('refuses a revoked session', async () => {
      const user = await seedUser(db, { email: 'revoked@example.internal' });
      const result = await login(user.email, DEFAULT_PASSWORD);

      await db.client
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.userId, user.id));

      const response = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('cookie', result.cookie!);

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('SESSION_EXPIRED');
    });

    it('refuses an expired session', async () => {
      const user = await seedUser(db, { email: 'expired@example.internal' });
      const result = await login(user.email, DEFAULT_PASSWORD);

      await db.client
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(sessions.userId, user.id));

      const response = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('cookie', result.cookie!);

      expect(response.status).toBe(401);
    });

    it('stops serving a session once the user is deactivated', async () => {
      const user = await seedUser(db, { email: 'disabled@example.internal' });
      const result = await login(user.email, DEFAULT_PASSWORD);

      await db.client.update(users).set({ isActive: false }).where(eq(users.id, user.id));

      const response = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('cookie', result.cookie!);

      expect(response.status).toBe(401);
    });

    it('revokes the session on logout', async () => {
      const user = await seedUser(db, { email: 'logout@example.internal' });
      const result = await login(user.email, DEFAULT_PASSWORD);

      const logout = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('cookie', result.cookie!)
        .set('origin', ORIGIN)
        .set('x-csrf-token', result.body.csrfToken!);

      expect(logout.status).toBe(204);

      const after = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('cookie', result.cookie!);

      expect(after.status).toBe(401);
    });
  });

  describe('CSRF', () => {
    it('refuses a mutation without a token', async () => {
      const user = await seedUser(db, { email: 'csrf1@example.internal' });
      const result = await login(user.email, DEFAULT_PASSWORD);

      const response = await request(app.getHttpServer())
        .post('/api/v1/mfa/setup')
        .set('cookie', result.cookie!)
        .set('origin', ORIGIN);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('CSRF_INVALID');
    });

    it('refuses a mutation with the wrong token', async () => {
      const user = await seedUser(db, { email: 'csrf2@example.internal' });
      const result = await login(user.email, DEFAULT_PASSWORD);

      const response = await request(app.getHttpServer())
        .post('/api/v1/mfa/setup')
        .set('cookie', result.cookie!)
        .set('origin', ORIGIN)
        .set('x-csrf-token', 'not-the-right-token');

      expect(response.status).toBe(403);
    });

    it('refuses a mutation from another origin', async () => {
      const user = await seedUser(db, { email: 'csrf3@example.internal' });
      const result = await login(user.email, DEFAULT_PASSWORD);

      const response = await request(app.getHttpServer())
        .post('/api/v1/mfa/setup')
        .set('cookie', result.cookie!)
        .set('origin', 'https://evil.example')
        .set('x-csrf-token', result.body.csrfToken!);

      expect(response.status).toBe(403);
    });

    it('accepts a mutation with the matching token and origin', async () => {
      const user = await seedUser(db, { email: 'csrf4@example.internal' });
      const result = await login(user.email, DEFAULT_PASSWORD);

      const response = await request(app.getHttpServer())
        .post('/api/v1/mfa/setup')
        .set('cookie', result.cookie!)
        .set('origin', ORIGIN)
        .set('x-csrf-token', result.body.csrfToken!);

      expect(response.status).toBe(200);
    });

    it('does not require a token for a read', async () => {
      const user = await seedUser(db, { email: 'csrf5@example.internal' });
      const result = await login(user.email, DEFAULT_PASSWORD);

      const response = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('cookie', result.cookie!);

      expect(response.status).toBe(200);
    });
  });
});
