import { readFileSync } from 'node:fs';

import { z } from 'zod';

/**
 * Runtime configuration.
 *
 * The schema is validated once at startup. Production refuses to start when a
 * security-relevant value is missing, so an incomplete deployment fails loudly
 * instead of running with an unsafe default.
 */

const duration = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value, ctx) => {
      const match = /^(\d+)(s|m|h|d)$/.exec(value.trim());

      if (!match) {
        ctx.addIssue({
          code: 'custom',
          message: `Expected a duration such as 30m, received "${value}"`,
        });
        return z.NEVER;
      }

      const amount = Number(match[1]);
      const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd'];
      return amount * unit;
    });

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(String(fallback) as 'true' | 'false')
    .transform((value) => value === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /**
     * The address the API binds.
     *
     * All interfaces by default, which is what a deployment without a proxy
     * needs. Behind a reverse proxy it belongs on the loopback address: the
     * proxy terminates TLS, and an API also listening on a public interface
     * would serve the same endpoints unencrypted alongside it.
     */
    HOST: z.string().min(1).default('0.0.0.0'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    /** Origin the browser application is served from; used for cookies and origin checks. */
    PUBLIC_APP_URL: z.url(),

    SESSION_COOKIE_NAME: z.string().min(1).default('dockplane_session'),
    SESSION_TTL: duration('12h'),
    /** Idle window after which a session is considered abandoned. */
    SESSION_IDLE_TIMEOUT: duration('2h'),

    /**
     * 32-byte key, base64 encoded, protecting MFA secrets at rest. It is not
     * derived from the database, so a database copy alone cannot decrypt them.
     */
    APPLICATION_ENCRYPTION_KEY: z
      .string()
      .refine((value) => Buffer.from(value, 'base64').length === 32, {
        message: 'APPLICATION_ENCRYPTION_KEY must be 32 bytes, base64 encoded',
      }),

    /** Number of proxies in front of the API that may set X-Forwarded-For. */
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    AGENT_GATEWAY_HOST: z.string().min(1).default('0.0.0.0'),
    /** 0 asks the operating system for a free port, which the tests rely on. */
    AGENT_GATEWAY_PORT: z.coerce.number().int().min(0).max(65535).default(9443),
    AGENT_GATEWAY_ADVERTISED_URL: z.url(),

    AGENT_GATEWAY_TLS_CERT_PATH: z.string().min(1),
    AGENT_GATEWAY_TLS_KEY_PATH: z.string().min(1),

    /** CA that agent client certificates must chain to. */
    AGENT_CLIENT_CA_CERT_PATH: z.string().min(1),
    AGENT_CA_CERT_PATH: z.string().min(1),
    AGENT_CA_KEY_PATH: z.string().min(1),
    AGENT_CA_KEY_PASSPHRASE: z.string().optional(),

    AGENT_CERT_TTL: duration('30d'),
    AGENT_CERT_RENEW_BEFORE: duration('7d'),
    AGENT_ENROLLMENT_TTL: duration('10m'),

    /*
     * How long a host bootstrap ticket lives.
     *
     * Short on purpose. The ticket reaches the target machine inside a command
     * an operator pastes into a shell, so it can survive in that shell's
     * history; a short life and single use are what keep that from mattering.
     */
    HOST_SETUP_TICKET_TTL: duration('10m'),

    /*
     * Where the agent packages come from.
     *
     * The default is the project's own releases, over HTTPS. It is overridable
     * so a release can be rehearsed against a local server before it exists on
     * GitHub — and the override is checked in production below, because a test
     * source that survives into a deployment would install unreviewed software
     * on every host somebody adds.
     */
    AGENT_RELEASE_BASE_URL: z.url().default('https://github.com/Dockplanee/dockplane/releases/download'),

    /*
     * The agent version a new host is given. Empty means "the version this
     * control plane is", which is the only pairing this project tests. It is
     * never "latest": an agent that arrives newer than the server it reports to
     * is a protocol mismatch nobody chose.
     */
    AGENT_RELEASE_VERSION: z.string().trim().default(''),

    /** Largest accepted agent protocol message. */
    AGENT_MAX_MESSAGE_BYTES: z.coerce.number().int().min(1024).default(1_048_576),

    /*
     * Whether this installation asks whether a newer Dockplane exists.
     *
     * Off, and off is the default on a new installation and on every upgrade:
     * a self-hosted control plane does not reach out because somebody opened a
     * page. Turned on, the control server reads the project's public release
     * listing on a long interval and shows the answer. The request carries
     * nothing about the installation — no identifier, no domain, no hostnames,
     * no counts — and nothing is downloaded, installed or changed by it.
     */
    UPDATE_CHECK_ENABLED: bool(false),

    /*
     * Live log streams.
     *
     * Every one of these is a ceiling rather than a target. A log stream holds
     * a Docker reader open on a managed host and a connection open here, so the
     * number of them has to be bounded by policy rather than by how many an
     * operator happens to open.
     */
    LOG_STREAM_MAX_PER_USER: z.coerce.number().int().min(1).max(50).default(3),
    LOG_STREAM_MAX_PER_AGENT: z.coerce.number().int().min(1).max(200).default(10),
    LOG_STREAM_MAX_TOTAL: z.coerce.number().int().min(1).max(1000).default(50),
    /** How long a single stream may run before it is closed and must be reopened. */
    LOG_STREAM_MAX_LIFETIME: duration('30m'),
    /** How often a running stream re-checks the session, permission and agent. */
    LOG_STREAM_REVALIDATE_INTERVAL: duration('30s'),
    /** Bytes that may wait for a browser that is not reading fast enough. */
    LOG_STREAM_MAX_BUFFERED_BYTES: z.coerce.number().int().min(64_000).default(1_048_576),
    /**
     * How often a quiet stream writes a comment to keep the connection open.
     *
     * A container that says nothing for minutes looks idle to a reverse proxy,
     * which closes it. The comment carries nothing and is not an event.
     */
    LOG_STREAM_KEEPALIVE_INTERVAL: duration('20s'),

    LOG_LEVEL: z
      .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),

    /**
     * Development-only switch that allows cookies without the Secure attribute
     * so the interface can be used over plain HTTP locally. Rejected in
     * production by the refinement below.
     */
    DEV_ALLOW_INSECURE_COOKIES: bool(false),
  })
  .superRefine((config, ctx) => {
    /*
     * A renewal window at least as long as the certificate lifetime puts the
     * renewal instant permanently in the past. Every agent would then rotate on
     * every connection and reconnect immediately afterwards, spending its time
     * replacing certificates instead of reporting on its host. This is checked
     * in every environment, because the failure is silent churn rather than an
     * error anyone would see.
     */
    if (config.AGENT_CERT_RENEW_BEFORE >= config.AGENT_CERT_TTL) {
      ctx.addIssue({
        code: 'custom',
        path: ['AGENT_CERT_RENEW_BEFORE'],
        message: 'AGENT_CERT_RENEW_BEFORE must be shorter than AGENT_CERT_TTL',
      });
    }

    if (config.NODE_ENV !== 'production') {
      return;
    }

    if (config.DEV_ALLOW_INSECURE_COOKIES) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_ALLOW_INSECURE_COOKIES'],
        message: 'Insecure cookies must not be enabled in production',
      });
    }

    if (!config.PUBLIC_APP_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_APP_URL'],
        message: 'PUBLIC_APP_URL must use https in production',
      });
    }

    if (!config.AGENT_GATEWAY_ADVERTISED_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['AGENT_GATEWAY_ADVERTISED_URL'],
        message: 'AGENT_GATEWAY_ADVERTISED_URL must use https in production',
      });
    }

    /*
     * Every host added through Dockplane installs whatever this address serves.
     * A local rehearsal source left behind in a deployment would be a supply
     * chain nobody reviewed, so it does not survive into production.
     */
    if (!config.AGENT_RELEASE_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['AGENT_RELEASE_BASE_URL'],
        message: 'AGENT_RELEASE_BASE_URL must use https in production',
      });
    }
  });

export type AppConfig = z.infer<typeof schema>;

export class ConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigurationError';
  }
}

/**
 * Reads a value that was supplied as a file rather than as a variable.
 *
 * Anything in the environment of a container is visible to whoever can run
 * `docker inspect`, and is inherited by every process the container starts. A
 * secret mounted as a file is neither. Any setting may be given as `NAME_FILE`
 * holding a path; the contents become `NAME`.
 */
export function resolveSecretFiles(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = { ...source };
  const problems: string[] = [];

  for (const [key, path] of Object.entries(source)) {
    if (!key.endsWith('_FILE') || !path) {
      continue;
    }

    const name = key.slice(0, -'_FILE'.length);

    if (source[name] !== undefined) {
      problems.push(`${name}: set as both a value and ${key}; supply one of them`);
      continue;
    }

    try {
      // Trimmed, because a file written by an editor or a shell almost always
      // ends in a newline and a key with a newline in it is not the key.
      resolved[name] = readFileSync(path, 'utf8').trim();
    } catch {
      problems.push(`${key}: ${path} could not be read`);
    }
  }

  if (problems.length > 0) {
    throw new ConfigurationError(problems);
  }

  return resolved;
}

/** Parses and validates configuration. Throws with every problem listed at once. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = schema.safeParse(resolveSecretFiles(source));

  if (!result.success) {
    throw new ConfigurationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  return result.data;
}

export const CONFIG = Symbol('DOCKPLANE_CONFIG');
