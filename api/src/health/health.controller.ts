import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';

import { Database } from '../database/database';
import { Public } from '../auth/public.decorator';

/**
 * Liveness and readiness.
 *
 * Both are unauthenticated because an orchestrator probes them before any
 * session exists, so neither reveals configuration: the response says whether
 * the server can serve traffic and nothing about how it is configured.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly db: Database) {}

  /** The process is running. It says nothing about dependencies. */
  @Public()
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** The server can serve requests, which requires a reachable database. */
  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<{
    status: 'ready' | 'unavailable';
    checks: { database: 'ok' | 'unavailable' };
  }> {
    const database = (await this.db.ping()) ? 'ok' : 'unavailable';

    if (database !== 'ok') {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'unavailable', checks: { database } };
    }

    return { status: 'ready', checks: { database } };
  }
}
