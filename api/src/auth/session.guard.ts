import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';

import { AppError } from '../common/errors';
import { AppConfig, CONFIG } from '../config/configuration';
import { Database } from '../database/database';
import { users } from '../database/schema';
import { currentContext } from '../logging/logger';
import { RbacService } from '../rbac/rbac.service';
import { AuthenticatedRequest } from './authenticated-request';
import { ALLOWS_MFA_PENDING, IS_PUBLIC } from './public.decorator';
import { SessionService } from './session.service';

/**
 * Establishes the caller's identity for every request.
 *
 * The guard is global and fails closed: a route is protected unless it is
 * explicitly marked public, so adding a controller cannot accidentally expose
 * it. A half-authenticated session reaches only the second-factor endpoints.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly rbac: RbacService,
    private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets) ?? false;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const token = request.cookies?.[this.config.SESSION_COOKIE_NAME] as string | undefined;

    if (!token) {
      if (isPublic) {
        return true;
      }

      throw AppError.unauthorized('SESSION_REQUIRED', 'Authentication is required.');
    }

    const session = await this.sessions.resolve(token);

    if (!session) {
      if (isPublic) {
        return true;
      }

      throw AppError.unauthorized('SESSION_EXPIRED', 'The session is no longer valid.');
    }

    const [user] = await this.db.client
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        mfaEnabled: users.mfaEnabled,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (!user) {
      throw AppError.unauthorized('SESSION_REVOKED', 'The session is no longer valid.');
    }

    const authorization = await this.rbac.authorizationFor(user.id);

    request.authSession = session;
    request.authUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      mfaEnabled: user.mfaEnabled,
      roles: authorization.roles,
      permissions: authorization.permissions,
    };

    const context_ = currentContext();
    if (context_) {
      context_.userId = user.id;
    }

    if (session.mfaPending) {
      const allowsPending =
        this.reflector.getAllAndOverride<boolean>(ALLOWS_MFA_PENDING, targets) ?? false;

      if (!allowsPending) {
        throw AppError.unauthorized(
          'AUTH_MFA_REQUIRED',
          'Multi-factor authentication is required.',
        );
      }
    }

    return true;
  }
}
