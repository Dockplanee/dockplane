import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { Database } from '../src/database/database';
import { userRoles } from '../src/database/schema';
import { DEFAULT_PASSWORD, createTestApp, resetData, resetThrottling, seedUser } from './app';

const ORIGIN = 'http://localhost:4200';

describe('authorization', () => {
  let app: INestApplication;
  let db: Database;

  const signIn = async (email: string) => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('origin', ORIGIN)
      .send({ email, password: DEFAULT_PASSWORD });

    const raw = response.headers['set-cookie'] as unknown as string[];

    return {
      cookie: raw.find((entry) => entry.startsWith('dockplane_session='))!.split(';')[0],
      csrf: response.body.csrfToken as string,
    };
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
    // Login is throttled per address, and the counter outlives resetData. A
    // suite with more sign-ins than the limit would otherwise fail on whichever
    // test happened to cross it.
    resetThrottling(app);
  });

  it('allows an endpoint when the role carries the permission', async () => {
    const user = await seedUser(db, { email: 'admin@example.internal', roleName: 'Administrator' });
    const session = await signIn(user.email);

    const response = await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('cookie', session.cookie);

    expect(response.status).toBe(200);
    expect(response.body.users).toHaveLength(1);
  });

  it('refuses an endpoint when the role lacks the permission', async () => {
    const user = await seedUser(db, { email: 'viewer@example.internal', roleName: 'Read Only' });
    const session = await signIn(user.email);

    const response = await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('cookie', session.cookie);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('PERMISSION_DENIED');
  });

  it('refuses a protected endpoint without a session', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/users');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('SESSION_REQUIRED');
  });

  it('fails closed for a user with no roles at all', async () => {
    const user = await seedUser(db, { email: 'nobody@example.internal' });
    const session = await signIn(user.email);

    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('cookie', session.cookie);

    expect(me.body.permissions).toEqual([]);

    for (const path of ['/api/v1/users', '/api/v1/roles', '/api/v1/audit']) {
      const response = await request(app.getHttpServer()).get(path).set('cookie', session.cookie);
      expect(response.status).toBe(403);
    }
  });

  it('stops granting access the moment a role is removed', async () => {
    const user = await seedUser(db, {
      email: 'demoted@example.internal',
      roleName: 'Administrator',
    });
    const session = await signIn(user.email);

    const before = await request(app.getHttpServer())
      .get('/api/v1/audit')
      .set('cookie', session.cookie);
    expect(before.status).toBe(200);

    await db.client.delete(userRoles).where(eq(userRoles.userId, user.id));

    const after = await request(app.getHttpServer())
      .get('/api/v1/audit')
      .set('cookie', session.cookie);
    expect(after.status).toBe(403);
  });

  it('reports only the permissions the roles actually carry', async () => {
    const user = await seedUser(db, { email: 'operator@example.internal', roleName: 'Operator' });
    const session = await signIn(user.email);

    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('cookie', session.cookie);

    expect(me.body.roles).toEqual(['Operator']);
    expect(me.body.permissions).toContain('hosts.read');
    expect(me.body.permissions).not.toContain('users.manage');

    /*
     * Operator restarts but does not stop.
     *
     * Restarting a stuck service is day-to-day work; taking one down and
     * leaving it down is a different decision, and inheriting it silently is
     * how a role stops meaning what its name says.
     */
    expect(me.body.permissions).toContain('containers.restart');
    expect(me.body.permissions).not.toContain('containers.stop');
    expect(me.body.permissions).not.toContain('containers.start');
  });

  describe('session ownership', () => {
    it('lets an operator list and revoke their own sessions', async () => {
      const user = await seedUser(db, { email: 'self@example.internal' });
      const session = await signIn(user.email);
      const other = await signIn(user.email);

      const listed = await request(app.getHttpServer())
        .get('/api/v1/sessions')
        .set('cookie', session.cookie);

      expect(listed.status).toBe(200);
      expect(
        listed.body.sessions.filter((entry: { current: boolean }) => entry.current),
      ).toHaveLength(1);

      const target = listed.body.sessions.find((entry: { current: boolean }) => !entry.current);

      const revoked = await request(app.getHttpServer())
        .delete(`/api/v1/sessions/${target.id}`)
        .set('cookie', session.cookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', session.csrf);

      expect(revoked.status).toBe(204);

      const dead = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('cookie', other.cookie);
      expect(dead.status).toBe(401);
    });

    it('refuses to revoke another account without the permission', async () => {
      const victim = await seedUser(db, { email: 'victim@example.internal' });
      const attacker = await seedUser(db, {
        email: 'attacker@example.internal',
        roleName: 'Read Only',
      });

      const victimSession = await signIn(victim.email);
      const attackerSession = await signIn(attacker.email);

      const listed = await request(app.getHttpServer())
        .get('/api/v1/sessions')
        .set('cookie', victimSession.cookie);
      const victimSessionId = listed.body.sessions[0].id;

      const response = await request(app.getHttpServer())
        .delete(`/api/v1/sessions/${victimSessionId}`)
        .set('cookie', attackerSession.cookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', attackerSession.csrf);

      expect(response.status).toBe(403);

      const alive = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('cookie', victimSession.cookie);
      expect(alive.status).toBe(200);
    });

    it('refuses to list another account without the permission', async () => {
      const victim = await seedUser(db, { email: 'target@example.internal' });
      const attacker = await seedUser(db, {
        email: 'nosy@example.internal',
        roleName: 'Read Only',
      });
      const session = await signIn(attacker.email);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/sessions?userId=${victim.id}`)
        .set('cookie', session.cookie);

      expect(response.status).toBe(403);
    });

    it('allows an administrator to review another account', async () => {
      const victim = await seedUser(db, { email: 'reviewed@example.internal' });
      const admin = await seedUser(db, {
        email: 'reviewer@example.internal',
        roleName: 'Administrator',
      });

      await signIn(victim.email);
      const session = await signIn(admin.email);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/sessions?userId=${victim.id}`)
        .set('cookie', session.cookie);

      expect(response.status).toBe(200);
      expect(response.body.sessions.length).toBeGreaterThan(0);
      expect(JSON.stringify(response.body)).not.toContain('tokenHash');
    });
  });
});
