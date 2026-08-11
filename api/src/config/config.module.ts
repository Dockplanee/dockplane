import { Global, Module } from '@nestjs/common';
import { Logger } from 'pino';

import { createLogger } from '../logging/logger';
import { AppConfig, CONFIG, loadConfig } from './configuration';
import { LOGGER, SECRET_BOX } from './tokens';
import { Database } from '../database/database';
import { SecretBox } from '../common/crypto';

/**
 * Configuration, logging, encryption and database access.
 *
 * Configuration is parsed exactly once here, so an invalid deployment fails
 * during module construction rather than on the first request that happens to
 * read a missing value.
 */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): AppConfig => loadConfig() },
    {
      provide: LOGGER,
      useFactory: (config: AppConfig): Logger => createLogger(config.LOG_LEVEL),
      inject: [CONFIG],
    },
    {
      provide: SECRET_BOX,
      useFactory: (config: AppConfig): SecretBox =>
        new SecretBox(config.APPLICATION_ENCRYPTION_KEY),
      inject: [CONFIG],
    },
    {
      provide: Database,
      useFactory: (config: AppConfig): Database => new Database(config.DATABASE_URL),
      inject: [CONFIG],
    },
  ],
  exports: [CONFIG, LOGGER, SECRET_BOX, Database],
})
export class AppConfigModule {}
