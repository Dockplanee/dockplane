import { Injectable } from '@nestjs/common';
import { and, isNull } from 'drizzle-orm';

import { MINIMUM_PROTOCOL_VERSION, PROTOCOL_VERSION } from '../agents/protocol';
import { Database } from '../database/database';
import { agents } from '../database/schema';
import { AgentVersionSummary, summariseAgentVersions } from './agent-versions';
import { BUILD_INFO } from './build-info';
import { EXPECTED_SCHEMA_VERSION, readSchemaState } from './schema-version';

/**
 * What is installed here.
 *
 * Local throughout: every field is read from this build or this database, so
 * the answer is the same whether or not the installation can reach anything.
 * What a published release says is a different question with a different
 * endpoint, because mixing them would make the local answer depend on the
 * network.
 */
export interface InstalledVersions {
  readonly controlServer: {
    readonly version: string;
    readonly commit: string;
  };
  readonly schema: {
    /** The migration this build ships. */
    readonly expected: string;
    /** The migration the database has reached, or null before the first. */
    readonly applied: string | null;
    readonly mismatch: boolean;
  };
  readonly protocol: {
    readonly server: number;
    readonly minimumSupported: number;
  };
  /** Present only for callers allowed to see the agents. */
  readonly agents: AgentVersionSummary | null;
}

@Injectable()
export class SystemVersionService {
  constructor(private readonly db: Database) {}

  async installed(options: { includeAgents: boolean }): Promise<InstalledVersions> {
    const schema = await readSchemaState(this.db).catch(() => ({ applied: null, missing: [] }));

    return {
      controlServer: {
        version: BUILD_INFO.version,
        commit: BUILD_INFO.commit,
      },
      schema: {
        expected: EXPECTED_SCHEMA_VERSION,
        applied: schema.applied,
        mismatch: schema.missing.length > 0,
      },
      protocol: {
        server: PROTOCOL_VERSION,
        minimumSupported: MINIMUM_PROTOCOL_VERSION,
      },
      agents: options.includeAgents ? await this.agentVersions() : null,
    };
  }

  /**
   * Counts versions in the database rather than in the browser.
   *
   * Revoked agents are left out: they are not running against this server, and
   * counting one would report a mixed fleet that does not exist.
   */
  private async agentVersions(): Promise<AgentVersionSummary> {
    const rows = await this.db.client
      .select({ version: agents.version, protocolVersion: agents.protocolVersion })
      .from(agents)
      .where(and(isNull(agents.revokedAt)));

    return summariseAgentVersions(rows);
  }
}
