import { Controller, Get } from '@nestjs/common';

import { PROTOCOL_VERSION } from '../agents/protocol';
import { Public } from '../auth/public.decorator';
import { Database } from '../database/database';
import { BUILD_INFO } from './build-info';
import { EXPECTED_SCHEMA_VERSION, readSchemaState } from './schema-version';

interface VersionResponse {
  readonly version: string;
  readonly commit: string;
  readonly buildDate: string;
  /** The agent protocol this build speaks. */
  readonly protocolVersion: number;
  /** The migration this build expects, and the one the database is at. */
  readonly schemaVersion: string;
  readonly appliedSchemaVersion: string | null;
}

/**
 * What is running here.
 *
 * An operator upgrading a deployment needs to be able to ask which build
 * answered, and whether its database has caught up. It is unauthenticated for
 * the same reason the health probes are — it is consulted before anyone signs
 * in — and it says nothing that is not already implied by the released
 * artefacts.
 */
@Controller('api/v1/version')
export class VersionController {
  constructor(private readonly db: Database) {}

  @Public()
  @Get()
  async version(): Promise<VersionResponse> {
    const schema = await readSchemaState(this.db).catch(() => ({ applied: null, missing: [] }));

    return {
      ...BUILD_INFO,
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: EXPECTED_SCHEMA_VERSION,
      appliedSchemaVersion: schema.applied,
    };
  }
}
