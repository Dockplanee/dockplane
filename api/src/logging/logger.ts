import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import pino, { DestinationStream, Logger, LoggerOptions } from 'pino';

/**
 * Structured logging.
 *
 * Secrets must never reach a log sink, so redaction is applied at the logger
 * rather than at each call site: a new call site cannot forget it. The paths
 * below cover the shapes credentials realistically arrive in — request bodies,
 * headers, cookies and error payloads.
 */

export const REDACTED = '[redacted]';

const SECRET_KEYS = [
  'password',
  'currentPassword',
  'newPassword',
  'passphrase',
  'token',
  'sessionToken',
  'enrollmentToken',
  'csrfToken',
  'totp',
  'totpSecret',
  'mfaSecret',
  'secret',
  'recoveryCode',
  'recoveryCodes',
  'privateKey',
  'key',
  'authorization',
  'cookie',
  'setCookie',
];

function redactionPaths(): string[] {
  const containers = [
    '',
    'body.',
    'req.body.',
    'request.body.',
    'payload.',
    'data.',
    'err.',
    'error.',
  ];

  const paths = containers.flatMap((prefix) => SECRET_KEYS.map((key) => `${prefix}${key}`));

  return [
    ...paths,
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
    'headers.authorization',
    'headers.cookie',
  ];
}

export interface RequestContext {
  readonly requestId: string;
  userId?: string;
  agentId?: string;
  hostId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function newRequestId(): string {
  return randomUUID();
}

/**
 * Builds the application logger.
 *
 * The destination is a parameter so a test can assert redaction against the
 * very configuration production uses, rather than a reconstruction of it.
 */
export function createLogger(
  level: string,
  service = 'dockplane-api',
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    level,
    base: { service },
    redact: { paths: redactionPaths(), censor: REDACTED },
    formatters: {
      level: (label) => ({ level: label }),
      // Correlation fields travel with the request rather than each call site.
      log: (object) => {
        const context = currentContext();

        return context
          ? {
              requestId: context.requestId,
              ...(context.userId ? { userId: context.userId } : {}),
              ...(context.agentId ? { agentId: context.agentId } : {}),
              ...(context.hostId ? { hostId: context.hostId } : {}),
              ...object,
            }
          : object;
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return destination ? pino(options, destination) : pino(options);
}
