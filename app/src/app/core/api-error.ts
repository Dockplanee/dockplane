import { HttpErrorResponse } from '@angular/common/http';

/**
 * Stable error codes the control server returns.
 *
 * The interface maps codes, never messages: a message is for a human to read
 * and may change, a code is the contract. An unrecognised code falls through to
 * a generic message rather than being shown raw.
 */
export type ApiErrorCode =
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_MFA_REQUIRED'
  | 'AUTH_MFA_INVALID'
  | 'AUTH_REAUTHENTICATION_REQUIRED'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'SESSION_REQUIRED'
  | 'CSRF_INVALID'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'VALIDATION_FAILED'
  | 'CONTAINER_NOT_FOUND'
  | 'CONTAINER_DETAIL_UNAVAILABLE'
  | 'CONTAINER_ALREADY_RUNNING'
  | 'CONTAINER_ALREADY_STOPPED'
  | 'ACTION_CONFLICT'
  | 'OPERATION_OUTCOME_UNKNOWN'
  | 'CONTAINER_IDENTITY_CONFLICT'
  | 'CONTAINER_NOT_MANAGED'
  | 'MANAGED_BY_STACK'
  | 'CONTAINER_NAME_IN_USE'
  | 'INVALID_CONTAINER_SPEC'
  | 'IMAGE_NOT_FOUND'
  | 'REPLACEMENT_FAILED'
  | 'CONTAINER_CREATE_FAILED'
  | 'CONTAINER_REMOVE_FAILED'
  | 'CONTAINER_STATE_UNRESOLVED'
  | 'AGENT_OFFLINE'
  | 'DOCKER_UNAVAILABLE'
  | 'DOCKER_PERMISSION_DENIED'
  | 'DOCKER_OPERATION_FAILED'
  | 'LOG_STREAM_UNAVAILABLE'
  | 'LOG_STREAM_TIMEOUT'
  | 'LOG_STREAM_OVERFLOW'
  | 'LOG_STREAM_LIMIT_REACHED'
  | 'CAPABILITY_UNSUPPORTED'
  | 'COMPOSE_PROJECT_NOT_FOUND'
  | 'COMPOSE_DETAIL_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'HOST_NOT_FOUND'
  | 'HOST_SETUP_NOT_FOUND'
  | 'HOST_SETUP_NOT_PENDING'
  | 'HOST_SETUP_TICKET_INVALID'
  | 'HOST_SETUP_UNAVAILABLE'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_UNKNOWN'
  | 'AGENT_REVOKED'
  | 'AGENT_NOT_CONNECTED'
  | 'AGENT_REQUEST_TIMEOUT'
  | 'ENROLLMENT_TOKEN_INVALID'
  | 'ENROLLMENT_TOKEN_EXPIRED'
  | 'ENROLLMENT_TOKEN_CONSUMED'
  | 'ENROLLMENT_TOKEN_REVOKED'
  | 'CONFLICT'
  | 'INTERNAL_ERROR'
  | 'NETWORK_UNAVAILABLE';

/**
 * A failure from the control server, in the form the interface works with.
 *
 * Anything the server did not send is not invented here: a transport failure
 * becomes `NETWORK_UNAVAILABLE` rather than being reported as an application
 * error the server never returned.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    override readonly message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True while the operator is signed in but lacks the required permission. */
  get isForbidden(): boolean {
    return this.status === 403 || this.code === 'PERMISSION_DENIED';
  }

  /** True when the session itself is the problem and signing in again is the fix. */
  get isUnauthenticated(): boolean {
    return (
      this.status === 401 &&
      this.code !== 'AUTH_INVALID_CREDENTIALS' &&
      this.code !== 'AUTH_MFA_INVALID'
    );
  }

  static from(error: unknown): ApiError {
    if (error instanceof ApiError) {
      return error;
    }

    if (!(error instanceof HttpErrorResponse)) {
      return new ApiError('INTERNAL_ERROR', GENERIC_MESSAGE, 0);
    }

    // Status 0 means the request never reached the server. Reporting that as an
    // application error would send an operator looking for the wrong problem.
    if (error.status === 0) {
      return new ApiError('NETWORK_UNAVAILABLE', MESSAGES.NETWORK_UNAVAILABLE, 0);
    }

    const body = (error.error ?? {}) as { code?: string; message?: string; requestId?: string };
    const code = isApiErrorCode(body.code) ? body.code : fallbackCode(error.status);

    return new ApiError(code, messageFor(code), error.status, body.requestId);
  }
}

const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

/**
 * What the operator reads.
 *
 * The server's own message is deliberately not shown. It is written for an API
 * consumer and can carry detail — an identifier, a reason — that belongs in a
 * log rather than in the interface.
 */
const MESSAGES: Record<ApiErrorCode, string> = {
  AUTH_INVALID_CREDENTIALS: 'That email address and password do not match an account.',
  AUTH_MFA_REQUIRED: 'Enter the code from your authenticator app.',
  AUTH_MFA_INVALID: 'That code was not accepted. Check the code and try again.',
  AUTH_REAUTHENTICATION_REQUIRED: 'Confirm your identity to continue.',
  SESSION_EXPIRED: 'Your session has expired. Sign in again to continue.',
  SESSION_REVOKED: 'Your session was revoked. Sign in again to continue.',
  SESSION_REQUIRED: 'Sign in to continue.',
  CSRF_INVALID: 'That request could not be verified. Reload the page and try again.',
  PERMISSION_DENIED: 'You do not have permission to do this.',
  RATE_LIMITED: 'Too many attempts. Wait a moment before trying again.',
  VALIDATION_FAILED: 'Some of the details are not valid.',
  CONTAINER_NOT_FOUND: 'This container no longer exists on its host.',
  CONTAINER_DETAIL_UNAVAILABLE:
    'The host has not been reachable since this container was discovered, so no detail has been read yet.',
  CONTAINER_ALREADY_RUNNING: 'This container is already running, so nothing was started.',
  CONTAINER_ALREADY_STOPPED: 'This container is not running, so nothing was stopped.',
  ACTION_CONFLICT: 'Another operation is already running on this container. Wait for it to finish.',
  /*
   * Not a failure, and worded so that nobody reads it as one. The host may have
   * done exactly what was asked; what is missing is the confirmation.
   */
  OPERATION_OUTCOME_UNKNOWN:
    'Dockplane sent the operation to the host but could not confirm the result. It is establishing what happened and will not repeat the operation.',
  CONTAINER_IDENTITY_CONFLICT:
    'More than one Docker container claims to be this one. Nothing can be done to it until that is resolved.',
  CONTAINER_NOT_MANAGED:
    'Dockplane did not create this container, so it will not change or remove it.',
  MANAGED_BY_STACK:
    'This container belongs to a Compose project, and its configuration comes from there.',
  CONTAINER_NAME_IN_USE: 'A container with this name already exists on that host.',
  INVALID_CONTAINER_SPEC: 'This configuration is not one Dockplane accepts.',
  IMAGE_NOT_FOUND: 'That image could not be found or pulled on the host.',
  REPLACEMENT_FAILED: 'The change was not applied. The container is as it was.',
  CONTAINER_CREATE_FAILED: 'The container was not created.',
  CONTAINER_REMOVE_FAILED: 'The container was not removed.',
  CONTAINER_STATE_UNRESOLVED:
    'The state of this container could not be established. Somebody needs to look at it.',
  AGENT_OFFLINE: 'The agent is not connected, so the operation was not carried out.',
  DOCKER_UNAVAILABLE: 'The Docker daemon on this host could not be reached.',
  DOCKER_PERMISSION_DENIED: 'The Docker daemon refused the operation for the agent.',
  DOCKER_OPERATION_FAILED: 'Docker could not carry out the operation.',
  LOG_STREAM_UNAVAILABLE: 'The logs could not be read from this host.',
  LOG_STREAM_TIMEOUT:
    'The log stream ran for its maximum time and was closed. Reconnect to continue.',
  LOG_STREAM_OVERFLOW:
    'The log stream was closed because output arrived faster than it could be shown.',
  LOG_STREAM_LIMIT_REACHED: 'Too many log streams are open. Close one and try again.',
  CAPABILITY_UNSUPPORTED: 'This host cannot do that.',
  COMPOSE_PROJECT_NOT_FOUND: 'This Compose project no longer exists on its host.',
  COMPOSE_DETAIL_UNAVAILABLE:
    'The host has not been reachable since this project was discovered, so no detail has been read yet.',
  NOT_FOUND: 'That does not exist.',
  HOST_NOT_FOUND: 'This host is no longer registered.',
  HOST_SETUP_NOT_FOUND: 'This host setup no longer exists.',
  HOST_SETUP_NOT_PENDING: 'This installation command has already been used or cancelled.',
  HOST_SETUP_TICKET_INVALID: 'This installation command is no longer valid.',
  HOST_SETUP_UNAVAILABLE:
    'This Dockplane build has no matching agent release, so it cannot add a host.',
  AGENT_NOT_FOUND: 'This agent is no longer registered.',
  AGENT_UNKNOWN: 'The control server does not recognise this agent.',
  AGENT_REVOKED: 'This agent credential has been revoked.',
  AGENT_NOT_CONNECTED: 'The agent is not connected, so the host cannot be reached right now.',
  AGENT_REQUEST_TIMEOUT: 'The host did not answer in time.',
  ENROLLMENT_TOKEN_INVALID: 'That enrollment token is not valid.',
  ENROLLMENT_TOKEN_EXPIRED: 'That enrollment token has expired.',
  ENROLLMENT_TOKEN_CONSUMED: 'That enrollment token has already been used.',
  ENROLLMENT_TOKEN_REVOKED: 'That enrollment token was withdrawn.',
  CONFLICT: 'That conflicts with the current state.',
  INTERNAL_ERROR: GENERIC_MESSAGE,
  NETWORK_UNAVAILABLE: 'The control server could not be reached.',
};

const CODES = new Set<string>(Object.keys(MESSAGES));

/**
 * What an operator should read for a code that did not arrive as a response.
 *
 * A stream reports its ending as an event rather than an HTTP failure, so the
 * code has to be turned into words somewhere. It happens here, with the same
 * table every other failure uses, rather than in the view.
 */
export function messageForCode(code: string): string {
  return isApiErrorCode(code) ? MESSAGES[code] : GENERIC_MESSAGE;
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && CODES.has(value);
}

function messageFor(code: ApiErrorCode): string {
  return MESSAGES[code];
}

function fallbackCode(status: number): ApiErrorCode {
  switch (status) {
    case 401:
      return 'SESSION_REQUIRED';
    case 403:
      return 'PERMISSION_DENIED';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL_ERROR';
  }
}
