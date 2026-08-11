import { Request } from 'express';

import { ActiveSession } from './session.service';
import { Permission } from '../rbac/permissions';

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly mfaEnabled: boolean;
  readonly roles: readonly string[];
  readonly permissions: ReadonlySet<Permission>;
}

/**
 * Request state established by the session guard.
 *
 * Handlers read identity from here and never from a body or query parameter,
 * so a caller cannot claim to be someone else.
 */
export interface AuthenticatedRequest extends Request {
  authSession?: ActiveSession;
  authUser?: AuthenticatedUser;
}
