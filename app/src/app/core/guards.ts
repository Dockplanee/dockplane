import { inject } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  CanActivateFn,
  Router,
  RouterStateSnapshot,
  UrlTree,
} from '@angular/router';

import { Auth } from './auth.service';
import { Permission, Permissions } from './permissions';
import { Session } from './session';

/**
 * Requires a signed-in session.
 *
 * The guard waits for the session check rather than assuming either answer, so
 * a reload never renders protected content for the moment before the server
 * has confirmed who is asking.
 */
async function runSessionGuard(
  _route: ActivatedRouteSnapshot,
  state: RouterStateSnapshot,
): Promise<boolean | UrlTree> {
  const session = inject(Session);
  const auth = inject(Auth);
  const router = inject(Router);

  if (session.isResolving()) {
    await auth.restore();
  }

  if (session.isAuthenticated()) {
    return true;
  }

  return signInAt(router, state.url);
}

export const requiresSession: CanActivateFn = runSessionGuard;

/**
 * Requires a permission the control server granted.
 *
 * A missing permission is not a sign-in problem: the operator stays signed in
 * and sees a forbidden page. Sending them to sign in again would suggest the
 * wrong fix and, with a valid session, would loop.
 */
export function requiresPermission(...permissions: readonly Permission[]): CanActivateFn {
  return async (route, state): Promise<boolean | UrlTree> => {
    /*
     * Injected before anything is awaited. `inject()` only works while the
     * injection context is current, and awaiting the session check leaves it.
     */
    const granted = inject(Permissions);
    const router = inject(Router);

    const allowed = await runSessionGuard(route, state);

    if (allowed !== true) {
      return allowed;
    }

    if (granted.hasAny(...permissions)) {
      return true;
    }

    return router.createUrlTree(['/forbidden'], { queryParams: { from: state.url } });
  };
}

/** Keeps a signed-in operator away from the sign-in page. */
export const requiresAnonymous: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  // Injected before awaiting: the injection context does not survive it.
  const session = inject(Session);
  const auth = inject(Auth);
  const router = inject(Router);

  if (session.isResolving()) {
    await auth.restore();
  }

  return session.isAuthenticated() ? router.createUrlTree(['/overview']) : true;
};

function signInAt(router: Router, url: string): UrlTree {
  // The requested route is carried so the operator lands where they were going,
  // not on a default page that hides what they asked for.
  return router.createUrlTree(['/login'], {
    queryParams: url && url !== '/' ? { returnUrl: url } : undefined,
  });
}
