import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withInMemoryScrolling } from '@angular/router';

import { routes } from './app.routes';
import { csrfInterceptor } from './core/csrf.interceptor';
import { sessionInterceptor } from './core/session.interceptor';
import { DockplaneApi } from './data/dockplane-api';
import { RealDockplaneApi } from './data/real-dockplane-api';

/**
 * Application providers.
 *
 * Authentication, the session and permissions come from the control server:
 * every request carries the session cookie, state-changing ones carry the CSRF
 * token, and a lost session becomes a sign-in rather than an error in a view.
 *
 * The Docker inventory comes from the same server. There is no fixture provider
 * here and no build flag that swaps one in: the test double lives in the test
 * setup, where a running application cannot reach it.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withInMemoryScrolling({ anchorScrolling: 'enabled' })),
    provideHttpClient(withInterceptors([csrfInterceptor, sessionInterceptor])),

    { provide: DockplaneApi, useClass: RealDockplaneApi },
  ],
};
