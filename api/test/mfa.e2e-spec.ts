import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';

import { SecretBox, hashSecret } from '../src/common/crypto';
import { Database } from '../src/database/database';
import { recoveryCodes, users } from '../src/database/schema';
import { DEFAULT_PASSWORD, createTestApp, resetData, resetThrottling, seedUser } from './app';

const ORIGIN = 'http://localhost:4200';
const ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');

describe('multi-factor authentication', () => {
  let app: INestApplication;
  let db: Database;

  const login = async (email: string) => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('origin', ORIGIN)
      .send({ email, password: DEFAULT_PASSWORD });

    const raw = response.headers['set-cookie'] as unknown as string[];
    return {
      status: response.status,
      body: response.body,
      cookie: raw.find((entry) => entry.startsWith('dockplane_session='))!.split(';')[0],
    };
  };

  const post = (path: string, cookie: string, csrf: string, body?: unknown) =>
    request(app.getHttpServer())
      .post(path)
      .set('cookie', cookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', csrf)
      .send(body ?? {});

  const totp = (secret: string, email: string) =>
    new TOTP({
      issuer: 'Dockplane',
      label: email,
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secret),
    }).generate();

  /** Signs in and completes setup, returning everything the tests need. */
  const enableMfa = async (email: string) => {
    const session = await login(email);
    const csrf = session.body.csrfToken;

    const setup = await post('/api/v1/mfa/setup', session.cookie, csrf);
    const secret = setup.body.secret as string;

    const confirm = await post('/api/v1/mfa/confirm', session.cookie, csrf, {
      code: totp(secret, email),
    });

    return {
      cookie: session.cookie,
      csrf,
      secret,
      recoveryCodes: confirm.body.recoveryCodes as string[],
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

  it('does not enable the factor until a code confirms setup', async () => {
    const user = await seedUser(db, { email: 'setup@example.internal' });
    const session = await login(user.email);

    await post('/api/v1/mfa/setup', session.cookie, session.body.csrfToken);

    const [row] = await db.client.select().from(users).where(eq(users.id, user.id));

    expect(row.mfaEnabled).toBe(false);
    expect(row.mfaConfirmedAt).toBeNull();
  });

  it('rejects a wrong confirmation code and stays disabled', async () => {
    const user = await seedUser(db, { email: 'wrongconfirm@example.internal' });
    const session = await login(user.email);

    await post('/api/v1/mfa/setup', session.cookie, session.body.csrfToken);
    const response = await post('/api/v1/mfa/confirm', session.cookie, session.body.csrfToken, {
      code: '000000',
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('AUTH_MFA_INVALID');

    const [row] = await db.client.select().from(users).where(eq(users.id, user.id));
    expect(row.mfaEnabled).toBe(false);
  });

  it('enables the factor with a valid code and issues recovery codes once', async () => {
    const user = await seedUser(db, { email: 'confirm@example.internal' });
    const result = await enableMfa(user.email);

    expect(result.recoveryCodes).toHaveLength(10);

    const [row] = await db.client.select().from(users).where(eq(users.id, user.id));
    expect(row.mfaEnabled).toBe(true);
  });

  it('stores the secret encrypted, not in clear', async () => {
    const user = await seedUser(db, { email: 'encrypted@example.internal' });
    const result = await enableMfa(user.email);

    const [row] = await db.client.select().from(users).where(eq(users.id, user.id));

    expect(row.mfaSecretEncrypted).not.toContain(result.secret);
    expect(row.mfaSecretEncrypted?.startsWith('v1.')).toBe(true);
    expect(new SecretBox(ENCRYPTION_KEY).decrypt(row.mfaSecretEncrypted!)).toBe(result.secret);
  });

  it('stores recovery codes only as digests', async () => {
    const user = await seedUser(db, { email: 'hashed@example.internal' });
    const result = await enableMfa(user.email);

    const rows = await db.client
      .select()
      .from(recoveryCodes)
      .where(eq(recoveryCodes.userId, user.id));

    const stored = rows.map((row) => row.codeHash);

    for (const code of result.recoveryCodes) {
      expect(stored).not.toContain(code);
      expect(stored).toContain(hashSecret(code));
    }
  });

  it('demands the second factor at the next sign-in', async () => {
    const user = await seedUser(db, { email: 'challenge@example.internal' });
    await enableMfa(user.email);

    const next = await login(user.email);

    expect(next.body.status).toBe('mfa_required');

    const me = await request(app.getHttpServer()).get('/api/v1/auth/me').set('cookie', next.cookie);

    expect(me.status).toBe(401);
    expect(me.body.code).toBe('AUTH_MFA_REQUIRED');
  });

  it('rejects a wrong challenge code', async () => {
    const user = await seedUser(db, { email: 'badcode@example.internal' });
    const secret = (await enableMfa(user.email)).secret;

    const next = await login(user.email);
    const response = await post('/api/v1/auth/mfa/verify', next.cookie, next.body.csrfToken, {
      code: '000000',
    });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_MFA_INVALID');
    expect(secret).toBeDefined();
  });

  it('accepts a valid challenge code and rotates the session', async () => {
    const user = await seedUser(db, { email: 'goodcode@example.internal' });
    const { secret } = await enableMfa(user.email);

    const next = await login(user.email);
    const response = await post('/api/v1/auth/mfa/verify', next.cookie, next.body.csrfToken, {
      code: totp(secret, user.email),
    });

    const raw = response.headers['set-cookie'] as unknown as string[];
    const rotated = raw.find((entry) => entry.startsWith('dockplane_session='))!.split(';')[0];

    expect(response.status).toBe(200);
    expect(rotated).not.toBe(next.cookie);

    const dead = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('cookie', next.cookie);
    expect(dead.status).toBe(401);

    const alive = await request(app.getHttpServer()).get('/api/v1/auth/me').set('cookie', rotated);
    expect(alive.status).toBe(200);
  });

  it('accepts a recovery code exactly once', async () => {
    const user = await seedUser(db, { email: 'recovery@example.internal' });
    const { recoveryCodes: codes } = await enableMfa(user.email);

    const first = await login(user.email);
    const accepted = await post('/api/v1/auth/mfa/verify', first.cookie, first.body.csrfToken, {
      code: codes[0],
    });
    expect(accepted.status).toBe(200);

    const second = await login(user.email);
    const reused = await post('/api/v1/auth/mfa/verify', second.cookie, second.body.csrfToken, {
      code: codes[0],
    });
    expect(reused.status).toBe(401);

    const other = await post('/api/v1/auth/mfa/verify', second.cookie, second.body.csrfToken, {
      code: codes[1],
    });
    expect(other.status).toBe(200);
  });

  it('invalidates previous recovery codes when they are regenerated', async () => {
    const user = await seedUser(db, { email: 'regen@example.internal' });
    const { secret, recoveryCodes: original } = await enableMfa(user.email);

    const session = await login(user.email);
    const verified = await post('/api/v1/auth/mfa/verify', session.cookie, session.body.csrfToken, {
      code: totp(secret, user.email),
    });

    const raw = verified.headers['set-cookie'] as unknown as string[];
    const cookie = raw.find((entry) => entry.startsWith('dockplane_session='))!.split(';')[0];
    const csrf = verified.body.csrfToken;

    const regenerated = await post('/api/v1/mfa/recovery-codes/regenerate', cookie, csrf, {
      code: totp(secret, user.email),
    });

    expect(regenerated.status).toBe(200);
    expect(regenerated.body.recoveryCodes).toHaveLength(10);
    expect(regenerated.body.recoveryCodes).not.toEqual(original);

    const next = await login(user.email);
    const stale = await post('/api/v1/auth/mfa/verify', next.cookie, next.body.csrfToken, {
      code: original[2],
    });

    expect(stale.status).toBe(401);
  });

  it('requires a current code to disable the factor', async () => {
    const user = await seedUser(db, { email: 'disable@example.internal' });
    const { secret } = await enableMfa(user.email);

    const session = await login(user.email);
    const verified = await post('/api/v1/auth/mfa/verify', session.cookie, session.body.csrfToken, {
      code: totp(secret, user.email),
    });

    const raw = verified.headers['set-cookie'] as unknown as string[];
    const cookie = raw.find((entry) => entry.startsWith('dockplane_session='))!.split(';')[0];
    const csrf = verified.body.csrfToken;

    // A wrong code from a signed-in operator is a rejected input, not an
    // expired session, so it must not answer 401 and send a client to login.
    const refused = await post('/api/v1/mfa/disable', cookie, csrf, { code: '000000' });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('AUTH_MFA_INVALID');

    const [stillEnabled] = await db.client.select().from(users).where(eq(users.id, user.id));
    expect(stillEnabled.mfaEnabled).toBe(true);

    const accepted = await post('/api/v1/mfa/disable', cookie, csrf, {
      code: totp(secret, user.email),
    });
    expect(accepted.status).toBe(204);

    const [row] = await db.client.select().from(users).where(eq(users.id, user.id));
    expect(row.mfaEnabled).toBe(false);
    expect(row.mfaSecretEncrypted).toBeNull();
  });
});
