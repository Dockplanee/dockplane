import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import * as schema from './schema';

/**
 * PostgreSQL access.
 *
 * The schema is applied by migrations only. Nothing here synchronises tables at
 * runtime, so a control server can never rewrite a production schema on start.
 */
@Injectable()
export class Database implements OnModuleDestroy {
  readonly client: NodePgDatabase<typeof schema>;

  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
    this.client = drizzle(this.pool, { schema });
  }

  /** Used by the readiness probe; a failure means the server cannot serve requests. */
  async ping(): Promise<boolean> {
    try {
      await this.client.execute(sql`select 1`);
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
