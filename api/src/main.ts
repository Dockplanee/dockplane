import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'pino';

import { AppModule } from './app.module';
import { ErrorResponseFilter } from './common/errors';
import { LOGGER } from './config/tokens';
import { AppConfig, CONFIG, ConfigurationError } from './config/configuration';
import { Database } from './database/database';
import { BUILD_INFO } from './version/build-info';
import { EXPECTED_SCHEMA_VERSION, readSchemaState } from './version/schema-version';

export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

  const config = app.get<AppConfig>(CONFIG);
  const logger = app.get<Logger>(LOGGER);

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());

  /**
   * The API and the browser application are served from different origins in
   * development. Credentials are only accepted from the configured application
   * origin; CORS is not a CSRF defence and the CSRF guard applies regardless.
   */
  app.enableCors({
    origin: config.PUBLIC_APP_URL.replace(/\/$/, ''),
    credentials: true,
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
  });

  // A wrong hop count would let a client spoof its source address and defeat
  // the per-address abuse controls, so the value is explicit configuration.
  app.set('trust proxy', config.TRUSTED_PROXY_HOPS);

  // Payload validation is per route through ZodValidationPipe, so no global
  // pipe is registered and class-validator is not a dependency.
  app.useGlobalFilters(new ErrorResponseFilter(logger));

  return app;
}

/**
 * Refuses to serve against a schema this build does not understand.
 *
 * An upgrade whose migration did not run would otherwise start, pass its
 * liveness probe and then fail on whichever request first touched a missing
 * column — a deployment that looks healthy and is not. Failing here makes a
 * half-applied upgrade visible at the only moment it can still be stopped.
 */
async function requireCurrentSchema(app: NestExpressApplication, logger: Logger): Promise<void> {
  const state = await readSchemaState(app.get(Database));

  if (state.missing.length === 0) {
    return;
  }

  logger.fatal(
    {
      event: 'schema_behind',
      expected: EXPECTED_SCHEMA_VERSION,
      applied: state.applied,
      missing: state.missing,
    },
    'the database schema is older than this build expects; run the migration',
  );

  throw new Error(
    `The database is missing ${state.missing.length} migration(s): ${state.missing.join(', ')}. ` +
      'Run the migration before starting this version.',
  );
}

/**
 * Stops on the signal an orchestrator sends, and says so.
 *
 * Node's default disposition for SIGTERM is to die where it stands, which
 * leaves agent connections and log streams to be discovered as broken by the
 * other end, and leaves no record that the stop was intended. An operator
 * reading the log after a restart could not tell a deployment from a crash.
 *
 * Closing the application runs the shutdown hooks — the gateway ends its
 * connections, running streams are closed, the database pool is drained — and
 * the process then exits successfully rather than reporting itself killed.
 */
function stopOnSignal(app: NestExpressApplication, logger: Logger): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ event: 'server_stopping', signal }, 'shutting down');

      void app.close().then(
        () => {
          logger.info({ event: 'server_stopped', signal }, 'control server stopped');
          process.exit(0);
        },
        (error: unknown) => {
          logger.error(
            {
              event: 'server_stop_failed',
              reason: error instanceof Error ? error.message : 'unknown',
            },
            'the control server did not shut down cleanly',
          );
          process.exit(1);
        },
      );
    });
  }
}

async function bootstrap(): Promise<void> {
  const app = await createApp();
  const config = app.get<AppConfig>(CONFIG);
  const logger = app.get<Logger>(LOGGER);

  await requireCurrentSchema(app, logger);

  stopOnSignal(app, logger);

  await app.listen(config.PORT, config.HOST);

  logger.info(
    {
      event: 'server_started',
      port: config.PORT,
      environment: config.NODE_ENV,
      version: BUILD_INFO.version,
      commit: BUILD_INFO.commit,
      schemaVersion: EXPECTED_SCHEMA_VERSION,
    },
    'control server listening',
  );
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    }

    process.exit(1);
  });
}
