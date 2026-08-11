import { eq } from 'drizzle-orm';

import { AppConfig } from '../config/configuration';
import { Database } from '../database/database';
import { sessions, users } from '../database/schema';
import { hashPassword, hashSecret } from '../common/crypto';
import { prepareDatabase, resetData } from '../../test/database';
import { SessionService } from './session.service';

const config = {
  SESSION_TTL: 3600,
  SESSION_IDLE_TIMEOUT: 1800,
} as AppConfig;

describe('SessionService', () => {
  let db: Database;
  let service: SessionService;
  let userId: string;

  beforeAll(async () => {
    db = await prepareDatabase();
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  beforeEach(async () => {
    await resetData(db);
    service = new SessionService(db, config);

    const [user] = await db.client
      .insert(users)
      .values({
        email: 'operator@example.internal',
        passwordHash: await hashPassword('a-passphrase'),
        displayName: 'Operator',
      })
      .returning({ id: users.id });

    userId = user.id;
  });

  it('never stores the raw session token', async () => {
    const issued = await service.issue(userId, { mfaPending: false });

    const [row] = await db.client.select().from(sessions).where(eq(sessions.id, issued.sessionId));

    expect(row.tokenHash).toBe(hashSecret(issued.token));
    expect(JSON.stringify(row)).not.toContain(issued.token);
    expect(JSON.stringify(row)).not.toContain(issued.csrfToken);
  });

  it('resolves a session from its raw token', async () => {
    const issued = await service.issue(userId, { mfaPending: false });
    const resolved = await service.resolve(issued.token);

    expect(resolved?.id).toBe(issued.sessionId);
    expect(resolved?.userId).toBe(userId);
  });

  it('does not resolve an unknown token', async () => {
    expect(await service.resolve('not-a-real-token')).toBeUndefined();
  });

  it('does not resolve a revoked session', async () => {
    const issued = await service.issue(userId, { mfaPending: false });
    await service.revoke(issued.sessionId);

    expect(await service.resolve(issued.token)).toBeUndefined();
  });

  it('does not resolve an expired session', async () => {
    const issued = await service.issue(userId, { mfaPending: false });

    await db.client
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, issued.sessionId));

    expect(await service.resolve(issued.token)).toBeUndefined();
  });

  it('retires a session that has been idle beyond the timeout', async () => {
    const issued = await service.issue(userId, { mfaPending: false });

    await db.client
      .update(sessions)
      .set({ lastSeenAt: new Date(Date.now() - (config.SESSION_IDLE_TIMEOUT + 60) * 1000) })
      .where(eq(sessions.id, issued.sessionId));

    expect(await service.resolve(issued.token)).toBeUndefined();

    const [row] = await db.client.select().from(sessions).where(eq(sessions.id, issued.sessionId));
    expect(row.revokedAt).not.toBeNull();
  });

  it('does not resolve a session whose user was deactivated', async () => {
    const issued = await service.issue(userId, { mfaPending: false });
    await db.client.update(users).set({ isActive: false }).where(eq(users.id, userId));

    expect(await service.resolve(issued.token)).toBeUndefined();
  });

  it('accepts only the matching CSRF token', async () => {
    const issued = await service.issue(userId, { mfaPending: false });
    const resolved = await service.resolve(issued.token);

    expect(service.verifyCsrf(resolved!, issued.csrfToken)).toBe(true);
    expect(service.verifyCsrf(resolved!, 'wrong')).toBe(false);
    expect(service.verifyCsrf(resolved!, undefined)).toBe(false);
  });

  it('marks a session as pending while the second factor is outstanding', async () => {
    const issued = await service.issue(userId, { mfaPending: true });

    expect((await service.resolve(issued.token))?.mfaPending).toBe(true);
  });

  it('rotates the session identifier when the second factor completes', async () => {
    const initial = await service.issue(userId, { mfaPending: true });
    const elevated = await service.completeMfa(initial.sessionId, {});

    expect(elevated.sessionId).not.toBe(initial.sessionId);
    expect(elevated.token).not.toBe(initial.token);
    // The half-authenticated token must be dead, not merely upgraded.
    expect(await service.resolve(initial.token)).toBeUndefined();
    expect((await service.resolve(elevated.token))?.mfaPending).toBe(false);
  });

  it('revokes every other session of a user while keeping the current one', async () => {
    const keep = await service.issue(userId, { mfaPending: false });
    const first = await service.issue(userId, { mfaPending: false });
    const second = await service.issue(userId, { mfaPending: false });

    const revoked = await service.revokeAllForUser(userId, keep.sessionId);

    expect(revoked).toBe(2);
    expect(await service.resolve(keep.token)).toBeDefined();
    expect(await service.resolve(first.token)).toBeUndefined();
    expect(await service.resolve(second.token)).toBeUndefined();
  });

  it('records the origin context of a session for review', async () => {
    const issued = await service.issue(userId, {
      mfaPending: false,
      userAgent: 'Mozilla/5.0 (review)',
      sourceIp: '203.0.113.10',
    });

    const [listed] = await service.listForUser(userId);

    expect(listed.id).toBe(issued.sessionId);
    expect(listed.userAgent).toBe('Mozilla/5.0 (review)');
    expect(listed.sourceIp).toBe('203.0.113.10');
  });
});
