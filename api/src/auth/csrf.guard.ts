import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';

import { AppError } from '../common/errors';
import { AppConfig, CONFIG } from '../config/configuration';
import { AuthenticatedRequest } from './authenticated-request';
import { SessionService } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_HEADER = 'x-csrf-token';

/**
 * Protects state-changing requests that authenticate with a cookie.
 *
 * Two independent checks apply, because either alone has a gap. The origin
 * check stops a cross-site form post, which cannot set request headers; the
 * per-session token stops a request that carries a plausible origin. CORS is
 * not part of this: a browser sends a cross-site form post regardless of CORS,
 * and the response being unreadable does not undo the state change.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (SAFE_METHODS.has(request.method)) {
      return true;
    }

    this.assertOriginAllowed(request);

    // Requests without a session cannot be cross-site forgeries against an
    // account; the origin check above still applies to them.
    if (!request.authSession) {
      return true;
    }

    const presented = request.header(CSRF_HEADER);

    if (!this.sessions.verifyCsrf(request.authSession, presented)) {
      throw AppError.forbidden('CSRF_INVALID', 'The request could not be verified.');
    }

    return true;
  }

  private assertOriginAllowed(request: AuthenticatedRequest): void {
    const origin = request.header('origin');
    const referer = request.header('referer');
    const declared = origin ?? (referer ? safeOrigin(referer) : undefined);

    // A browser always sends Origin on a cross-site state-changing request, so
    // a missing value means a non-browser client, which cannot be forged into.
    if (!declared) {
      return;
    }

    if (declared !== this.config.PUBLIC_APP_URL.replace(/\/$/, '')) {
      throw AppError.forbidden('CSRF_INVALID', 'The request could not be verified.');
    }
  }
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
