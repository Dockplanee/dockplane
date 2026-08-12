import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import { eq } from 'drizzle-orm';

import { AppModule } from '../src/app.module';
import { ErrorResponseFilter } from '../src/common/errors';
import { hashPassword } from '../src/common/crypto';
import { LOGGER } from '../src/config/tokens';
import { Database } from '../src/database/database';
import { roles, userRoles, users } from '../src/database/schema';
import { TEST_DATABASE_URL, prepareDatabase, resetData } from './database';
import { TestPki, createTestPki } from './agent-pki';

/**
 * Boots the real application for integration tests.
 *
 * Guards, filters and middleware are the ones production uses, so a test that
 * reaches an endpoint proves the actual protection path rather than a stub.
 */
let sharedPki: TestPki | undefined;

/** Certificate material is generated once and reused across suites. */
export async function testPki(): Promise<TestPki> {
  sharedPki ??= await createTestPki();
  return sharedPki;
}

export async function createTestApp(): Promise<INestApplication> {
  await prepareDatabase().then((db) => db.onModuleDestroy());

  const pki = await testPki();

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    PUBLIC_APP_URL: 'http://localhost:4200',
    APPLICATION_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    AGENT_GATEWAY_ADVERTISED_URL: 'https://localhost:9443',
    // Port 0 lets the operating system pick a free port, so a test run cannot
    // collide with a real gateway or with another project's service.
    AGENT_GATEWAY_PORT: '0',
    AGENT_GATEWAY_HOST: '127.0.0.1',
    AGENT_GATEWAY_TLS_CERT_PATH: pki.gatewayCertPath,
    AGENT_GATEWAY_TLS_KEY_PATH: pki.gatewayKeyPath,
    AGENT_CLIENT_CA_CERT_PATH: pki.caCertPath,
    AGENT_CA_CERT_PATH: pki.caCertPath,
    AGENT_CA_KEY_PATH: pki.caKeyPath,
    DEV_ALLOW_INSECURE_COOKIES: 'true',
    /*
     * A test build has no published release, and the bootstrap refuses to name
     * one it cannot point at. Tests pin a version the same way a rehearsal
     * deployment does.
     */
    AGENT_RELEASE_VERSION: '0.1.0-rc.2',
    /*
     * A short keepalive so a test can observe one without waiting. The interval
     * is a deployment choice; what a test asserts is that a quiet stream is
     * kept open at all.
     */
    LOG_STREAM_KEEPALIVE_INTERVAL: '1s',
    /*
     * Silent by default, because a passing run has nothing to say. Set
     * TEST_LOG_LEVEL to make the server account for itself while chasing an
     * intermittent failure.
     */
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();

  app.use(cookieParser());
  app.useGlobalFilters(new ErrorResponseFilter(app.get(LOGGER)));

  await app.init();

  /*
   * The API listens on a loopback address of its own.
   *
   * Without this, supertest binds a fresh wildcard socket for every request and
   * closes it again afterwards. A wildcard bind and the gateway's `127.0.0.1`
   * bind may hold the same port number at once — BSD allows it when the
   * addresses differ — and a request to `127.0.0.1:<port>` then reaches the
   * more specific listener, which is the TLS gateway. The HTTP client reads a
   * TLS handshake and fails with a parse error.
   *
   * Binding the API to `127.0.0.1` as well makes the two listeners compete for
   * the same address, so the operating system refuses a collision outright
   * instead of handing out a port that is already in use for another protocol.
   */
  await app.listen(0, '127.0.0.1');

  return app;
}

export interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

export const DEFAULT_PASSWORD = 'a-long-development-passphrase';

export async function seedUser(
  db: Database,
  options: { email: string; roleName?: string; isActive?: boolean; password?: string },
): Promise<TestUser> {
  const password = options.password ?? DEFAULT_PASSWORD;

  const [user] = await db.client
    .insert(users)
    .values({
      email: options.email,
      passwordHash: await hashPassword(password),
      displayName: options.email,
      isActive: options.isActive ?? true,
    })
    .returning({ id: users.id });

  if (options.roleName) {
    const [role] = await db.client
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, options.roleName))
      .limit(1);

    await db.client.insert(userRoles).values({ userId: user.id, roleId: role.id });
  }

  return { id: user.id, email: options.email, password };
}

/**
 * Clears rate-limit counters between tests.
 *
 * Every request in a suite comes from the same address, so without this the
 * limiter would correctly refuse later tests for reasons that have nothing to
 * do with what they assert.
 */
export function resetThrottling(app: INestApplication): void {
  const storage = app.get<{
    _storage?: Map<string, unknown> | Record<string, unknown>;
    timeoutIds?: Map<string, NodeJS.Timeout[]> | Record<string, NodeJS.Timeout[]>;
  }>(ThrottlerStorage, { strict: false });

  /*
   * The timers go first.
   *
   * Each recorded hit leaves a timer that expires it later. Clearing only the
   * entries leaves those timers pointing at records that no longer exist, and a
   * test that runs long enough for one to fire dies inside the throttler rather
   * than on anything it was testing.
   */
  const timers = storage?.timeoutIds;

  if (timers instanceof Map) {
    for (const handles of timers.values()) {
      handles.forEach(clearTimeout);
    }

    timers.clear();
  } else if (timers) {
    for (const key of Object.keys(timers)) {
      timers[key].forEach(clearTimeout);
      delete timers[key];
    }
  }

  const entries = storage?._storage;

  if (entries instanceof Map) {
    entries.clear();
  } else if (entries) {
    for (const key of Object.keys(entries)) {
      delete entries[key];
    }
  }
}

export { resetData };
