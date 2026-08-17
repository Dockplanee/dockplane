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
  /*
   * The agent runs a release that predates part of what the operation needs.
   * Distinct from an unsupported protocol: the agent speaks the protocol and
   * goes on serving everything else.
   */
  'AGENT_UPGRADE_REQUIRED',
  'AGENT_CAPABILITY_FAILED',
  'AGENT_RESPONSE_INVALID',
  'AGENT_NOT_CONNECTED',
  'DOCKER_UNAVAILABLE',
  'HOST_NOT_FOUND',
  /* The host is archived, so it is not a target for new operational work. */
  'HOST_ARCHIVED',
  /* Its agent is connected, so it is in use and cannot be archived. */
  'HOST_CONNECTED',
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
  /*
   * The host has a container, volume or network with a name a stack needs, and
   * did not create it for that stack. Reported by the agent, which is the side
   * that can see all three.
   */
  'STACK_RESOURCE_CONFLICT',
  /*
   * The containers of a stack on its host do not add up: two of them claim the
   * same service. Reported by the agent, which is the side that can see them.
   */
  'STACK_STATE_AMBIGUOUS',
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
  /*
   * The Compose file could not be turned into something deployable.
   *
   * Separate from a Compose file that is wrong: this is the compiler failing,
   * timing out or answering with something this build does not understand.
   * Either way nothing is deployed — a compile that did not finish is never
   * treated as one that produced nothing to object to.
   */
  'COMPOSE_COMPILER_FAILED',
  'COMPOSE_COMPILER_UNAVAILABLE',
  'COMPOSE_INVALID',
  'STACK_NOT_FOUND',
  'STACK_NAME_CONFLICT',
  /*
   * Somebody else saved a revision while this one was being edited. Refused
   * rather than written over: an operator can reload and reapply, which is the
   * only way they find out before rather than after.
   */
  'STACK_REVISION_CONFLICT',
  'STACK_CONFIGURATION_INVALID',
  /*
   * A stack that already runs somewhere. Deploying it again would be an update
   * to what is running, which is a different operation with different
   * consequences and is refused rather than approximated.
   */
  'STACK_ALREADY_DEPLOYED',
  /* The stack is already running the revision somebody asked for. */
  'STACK_REVISION_ALREADY_DEPLOYED',
  /*
   * More than one container claims to be the same service of a stack. Nothing
   * may be applied over that, and choosing between them is a person's job.
   */
  'STACK_REPAIR_AMBIGUOUS',
  /* The revision did not come up. What the stack is has not changed. */
  'STACK_APPLY_FAILED',
  /*
   * The revision did not come up and putting the host back did not fully work.
   * Reported by the agent, and never used to claim a rollback succeeded.
   */
  'STACK_ROLLBACK_INCOMPLETE',
  /*
   * A volume the stack was using is not on the host. Never replaced with an
   * empty one of the same name.
   */
  'VOLUME_MISSING',
  /* A deployment of this stack is running, or one never finished. */
  'STACK_DEPLOYMENT_CONFLICT',
  /*
   * The deployment did not happen and left nothing behind. The host is as it
   * was, so whatever was wrong can be fixed and the stack deployed again.
   */
  'STACK_DEPLOYMENT_FAILED',
  /*
   * Part of the stack is running and part of it is not.
   *
   * Nothing is removed on the way out: a container that started may already
   * have written to a volume. The stack is not recorded as deployed and waits
   * for a person.
   */
  'STACK_DEPLOYMENT_PARTIAL',
  'STACK_NEEDS_ATTENTION',
  /*
   * A stack that has never been deployed. Starting, stopping and restarting act
   * on containers that exist, and nothing here creates one: a stack with no
   * deployed revision has nothing to move between running and stopped.
   */
  'STACK_NOT_DEPLOYED',
  /* An operation on this stack is running, or one never finished. */
  'STACK_OPERATION_CONFLICT',
  /*
   * A service the stack should have has no container on the host. Never
   * answered by creating one: that is deploying a revision.
   */
  'STACK_SERVICE_MISSING',
  /* The stack did not reach the state that was asked for. */
  'STACK_START_FAILED',
  'STACK_STOP_FAILED',
  'STACK_RESTART_FAILED',
  /*
   * Some services moved and others did not.
   *
   * Nothing is undone to tidy that up — a container that stopped may be the one
   * holding a lock somebody needs — and the stack waits for a person.
   */
  'STACK_LIFECYCLE_PARTIAL',
  /* The stack's containers were not removed. Everything about it is as it was. */
  'STACK_DELETE_FAILED',
  /*
   * Some of the stack's containers are gone and some are not.
   *
   * Nothing is rebuilt and nothing about the saved configuration is removed:
   * that is what somebody needs in order to make sense of the host.
   */
  'STACK_DELETE_PARTIAL',
  /*
   * Something on the host already has a name the stack needs. Never resolved by
   * renaming or removing whatever is in the way — it belongs to somebody.
   */
  'RESOURCE_NAME_CONFLICT',
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
    /*
     * Where a failure is a list of things to fix rather than one thing that
     * went wrong. A Compose file can be wrong in several places, and an
     * operator who is told about one of them at a time fixes it several times.
     *
     * Never free-form detail: these come from the compiler, which is written
     * not to quote a value it was given.
     */
    readonly details?: readonly { code: string; message: string; path?: string }[],
  ) {
    super({ code, message, ...(details ? { details } : {}) }, status);
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
  readonly details?: readonly unknown[];
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
      const payload = exception.getResponse() as {
        code: ErrorCode;
        message: string;
        details?: readonly unknown[];
      };

      return {
        status: exception.getStatus(),
        body: {
          code: payload.code,
          message: payload.message,
          ...(payload.details ? { details: payload.details } : {}),
          requestId,
        },
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
    case HttpStatus.PAYLOAD_TOO_LARGE:
      /*
       * The body parser refused the request before any handler saw it. That is
       * a request that is too big, which is a caller's to fix — reporting it as
       * an internal failure would send somebody looking at the server.
       */
      return 'VALIDATION_FAILED';
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
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return 'The request is larger than this server accepts.';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'Too many requests. Try again later.';
    case HttpStatus.BAD_REQUEST:
      return 'The request was not valid.';
    default:
      return 'The request could not be completed.';
  }
}
