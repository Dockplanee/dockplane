import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Logger } from 'pino';

import { currentContext } from '../logging/logger';

/**
 * Stable machine-readable error codes.
 *
 * Unauthenticated failures deliberately collapse into a single credential
 * error: distinguishing "no such user" from "wrong password" would turn the
 * login endpoint into an account enumeration oracle.
 */
export const ERROR_CODES = [
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_MFA_REQUIRED',
  'AUTH_MFA_INVALID',
  'AUTH_REAUTHENTICATION_REQUIRED',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'SESSION_REQUIRED',
  'CSRF_INVALID',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'VALIDATION_FAILED',
  'ENROLLMENT_TOKEN_INVALID',
  'ENROLLMENT_TOKEN_EXPIRED',
  'ENROLLMENT_TOKEN_CONSUMED',
  'ENROLLMENT_TOKEN_REVOKED',
  'ENROLLMENT_CSR_INVALID',
  'AGENT_CERT_INVALID',
  'AGENT_CERT_EXPIRED',
  'AGENT_UNKNOWN',
  'AGENT_IDENTITY_MISMATCH',
  'AGENT_REVOKED',
  'AGENT_PROTOCOL_UNSUPPORTED',
  'AGENT_MESSAGE_TOO_LARGE',
  'AGENT_REQUEST_EXPIRED',
  'AGENT_REQUEST_TIMEOUT',
  'AGENT_CAPABILITY_UNSUPPORTED',
  'AGENT_CAPABILITY_FAILED',
  'AGENT_RESPONSE_INVALID',
  'AGENT_NOT_CONNECTED',
  'DOCKER_UNAVAILABLE',
  'HOST_NOT_FOUND',
  'HOST_SETUP_NOT_FOUND',
  'HOST_SETUP_NOT_PENDING',
  'HOST_SETUP_TICKET_INVALID',
  'HOST_SETUP_UNAVAILABLE',
  'CONTAINER_NOT_FOUND',
  'CONTAINER_DETAIL_UNAVAILABLE',
  'CONTAINER_ALREADY_RUNNING',
  'CONTAINER_ALREADY_STOPPED',
  /*
   * Two Docker containers claim one Dockplane identity, which is what a crash
   * midway through a replacement leaves behind. Choosing between them would
   * mean guessing, and a wrong guess removes a workload, so every mutation is
   * refused until a person resolves it. Reading is still allowed.
   */
  'CONTAINER_IDENTITY_CONFLICT',
  /* The container belongs to a stack, and its configuration comes from there. */
  'MANAGED_BY_STACK',
  /* The container was found by discovery; Dockplane was never told what it should be. */
  'CONTAINER_NOT_MANAGED',
  'INVALID_CONTAINER_SPEC',
  'CONTAINER_NAME_IN_USE',
  'IMAGE_NOT_FOUND',
  'REPLACEMENT_FAILED',
  'CONTAINER_CREATE_FAILED',
  'CONTAINER_REMOVE_FAILED',
  /*
   * An operation stopped partway through and what it left behind cannot be
   * resolved without a person: a container claiming a configuration nobody
   * asked for, or one that will not say which configuration it is. Recovery
   * says so rather than guessing, and the container refuses further mutation
   * until somebody settles it.
   */
  'CONTAINER_STATE_UNRESOLVED',
  /*
   * The request reached the host and its answer did not come back.
   *
   * Distinct from a failure, and the distinction is the point: Docker may have
   * done exactly what was asked. Dockplane establishes which from the host
   * rather than repeating the operation, and refuses further changes to that
   * container until it has. A client that retries on this gets the refusal
   * rather than a second change.
   */
  'OPERATION_OUTCOME_UNKNOWN',
  'ACTION_CONFLICT',
  'ACTION_TIMEOUT',
  'AGENT_OFFLINE',
  'CAPABILITY_UNSUPPORTED',
  'LOG_STREAM_UNAVAILABLE',
  'LOG_STREAM_TIMEOUT',
  'LOG_STREAM_OVERFLOW',
  'LOG_STREAM_LIMIT_REACHED',
  'DOCKER_PERMISSION_DENIED',
  'DOCKER_OPERATION_FAILED',
  'COMPOSE_PROJECT_NOT_FOUND',
  'COMPOSE_DETAIL_UNAVAILABLE',
  'AGENT_NOT_FOUND',
  'USER_NOT_FOUND',
  'ROLE_NOT_FOUND',
  'CONFLICT',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super({ code, message }, status);
  }

  static unauthorized(code: ErrorCode, message: string): AppError {
    return new AppError(code, message, HttpStatus.UNAUTHORIZED);
  }

  static forbidden(code: ErrorCode, message: string): AppError {
    return new AppError(code, message, HttpStatus.FORBIDDEN);
  }

  static notFound(code: ErrorCode, message: string): AppError {
    return new AppError(code, message, HttpStatus.NOT_FOUND);
  }

  static conflict(code: ErrorCode, message: string): AppError {
    return new AppError(code, message, HttpStatus.CONFLICT);
  }
}

interface ErrorBody {
  readonly code: ErrorCode;
  readonly message: string;
  readonly requestId: string;
}

/**
 * Converts every failure into the documented response shape.
 *
 * An unexpected error is logged in full and answered with a generic message,
 * so an internal detail or stack trace never reaches a client.
 */
@Injectable()
@Catch()
export class ErrorResponseFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const requestId = currentContext()?.requestId ?? 'unknown';

    const { status, body } = this.describe(exception, requestId);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { err: exception, path: request.path, method: request.method },
        'request failed',
      );
    }

    response.status(status).json(body);
  }

  private describe(exception: unknown, requestId: string): { status: number; body: ErrorBody } {
    if (exception instanceof AppError) {
      const payload = exception.getResponse() as { code: ErrorCode; message: string };

      return {
        status: exception.getStatus(),
        body: { code: payload.code, message: payload.message, requestId },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();

      return {
        status,
        body: {
          code: mapHttpStatus(status),
          message: genericMessage(status),
          requestId,
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed.',
        requestId,
      },
    };
  }
}

function mapHttpStatus(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return 'SESSION_REQUIRED';
    case HttpStatus.FORBIDDEN:
      return 'PERMISSION_DENIED';
    case HttpStatus.NOT_FOUND:
      /*
       * A 404 that no handler produced is an address that does not exist, not
       * a resource that is missing. Naming a resource here — a host, say —
       * would tell a client that a machine had disappeared because a URL was
       * misspelled.
       */
      return 'NOT_FOUND';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    case HttpStatus.BAD_REQUEST:
      return 'VALIDATION_FAILED';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    default:
      return 'INTERNAL_ERROR';
  }
}

function genericMessage(status: number): string {
  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return 'Authentication is required.';
    case HttpStatus.FORBIDDEN:
      return 'You do not have permission to perform this action.';
    case HttpStatus.NOT_FOUND:
      return 'The requested resource does not exist.';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'Too many requests. Try again later.';
    case HttpStatus.BAD_REQUEST:
      return 'The request was not valid.';
    default:
      return 'The request could not be completed.';
  }
}
