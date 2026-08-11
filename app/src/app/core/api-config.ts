import { InjectionToken } from '@angular/core';

/**
 * Where the control server lives.
 *
 * A relative base is the deployed shape: the interface and the API are served
 * behind one origin, so no CORS exception and no cross-site cookie is needed.
 * A build for a separate origin overrides this token.
 */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => '',
});
