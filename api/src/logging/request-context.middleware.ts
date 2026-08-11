import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { Logger } from 'pino';

import { LOGGER } from '../config/tokens';
import { newRequestId, runWithContext } from './logger';

/** Header a caller may use to carry an existing correlation id into the API. */
const REQUEST_ID_HEADER = 'x-request-id';

/** Bounded so a caller cannot push arbitrary content into every log line. */
const MAX_REQUEST_ID_LENGTH = 64;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Establishes the correlation context for a request.
 *
 * Everything logged while handling the request carries the same id, and the id
 * is returned to the caller so an operator can quote it when reporting a
 * failure. An inbound id is only reused when it is short and alphanumeric.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const inbound = request.header(REQUEST_ID_HEADER);
    const requestId =
      inbound && inbound.length <= MAX_REQUEST_ID_LENGTH && SAFE_REQUEST_ID.test(inbound)
        ? inbound
        : newRequestId();

    response.setHeader(REQUEST_ID_HEADER, requestId);

    runWithContext({ requestId }, () => {
      const startedAt = process.hrtime.bigint();

      response.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

        this.logger.info(
          {
            event: 'http_request',
            method: request.method,
            path: request.route?.path ?? request.path,
            status: response.statusCode,
            durationMs: Math.round(durationMs),
          },
          'request completed',
        );
      });

      next();
    });
  }
}
