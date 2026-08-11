import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';

import { Session } from './session';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Attaches the CSRF token to state-changing requests.
 *
 * The token pairs with the session cookie: a request carrying the cookie but
 * not the token is refused, which is what stops another site from acting
 * through a browser that happens to be signed in. Reads do not carry it,
 * because the server does not require it for them.
 */
export const csrfInterceptor: HttpInterceptorFn = (request, next) => {
  if (!STATE_CHANGING.has(request.method)) {
    return next(request);
  }

  const token = inject(Session).csrfToken();

  if (!token) {
    // Nothing to add. The server will refuse the request, which is the correct
    // outcome: a state-changing call without a session has no business
    // succeeding, and inventing a token here would only hide that.
    return next(request);
  }

  return next(request.clone({ setHeaders: { 'x-csrf-token': token } }));
};
