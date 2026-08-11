import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

import { EXPECTS_UNAUTHENTICATED } from './api-client';
import { Session } from './session';

/**
 * Turns a lost session into a sign-in, and nothing else into one.
 *
 * Only 401 means the session is the problem. A 403 is an authorization answer
 * for an operator who is signed in perfectly well: signing them out for asking
 * about something they may not see would be wrong, and would loop as soon as
 * the page they land on asks the same question again.
 */
export const sessionInterceptor: HttpInterceptorFn = (request, next) => {
  const session = inject(Session);
  const router = inject(Router);

  return next(request).pipe(
    catchError((error: unknown) => {
      const expected = request.context.get(EXPECTS_UNAUTHENTICATED);

      if (!expected && error instanceof HttpErrorResponse && error.status === 401) {
        session.anonymous();

        // Already on the way out; a second navigation would fight the first.
        if (!router.url.startsWith('/login')) {
          void router.navigate(['/login'], {
            queryParams: router.url === '/' ? undefined : { returnUrl: router.url },
          });
        }
      }

      return throwError(() => error);
    }),
  );
};
