import { HttpClient, HttpContext, HttpContextToken, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, throwError } from 'rxjs';

import { ApiError } from './api-error';
import { API_BASE_URL } from './api-config';

/**
 * Marks a request that must not trigger the signed-out transition on 401.
 *
 * Sign-in and the session check are expected to answer 401 for an anonymous
 * visitor; treating that as a session loss would fight with the flow that is
 * establishing the session in the first place.
 */
export const EXPECTS_UNAUTHENTICATED = new HttpContextToken<boolean>(() => false);

export function anonymousRequest(): HttpContext {
  return new HttpContext().set(EXPECTS_UNAUTHENTICATED, true);
}

/**
 * The control server, as the interface talks to it.
 *
 * Every request carries the session cookie, which is what `withCredentials`
 * does; the browser holds it and script never sees it. Failures arrive as
 * `ApiError` so a caller deals with a stable code rather than a transport
 * object.
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  get<T>(path: string, params?: Record<string, string | number | undefined>): Observable<T> {
    return this.http
      .get<T>(this.url(path), { params: toParams(params), withCredentials: true })
      .pipe(catchError(fail));
  }

  post<T>(path: string, body?: unknown, context?: HttpContext): Observable<T> {
    return this.http
      .post<T>(this.url(path), body ?? {}, { withCredentials: true, context })
      .pipe(catchError(fail));
  }

  delete<T>(path: string): Observable<T> {
    return this.http.delete<T>(this.url(path), { withCredentials: true }).pipe(catchError(fail));
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }
}

function toParams(values?: Record<string, string | number | undefined>): HttpParams {
  let params = new HttpParams();

  for (const [key, value] of Object.entries(values ?? {})) {
    if (value !== undefined && value !== '') {
      params = params.set(key, String(value));
    }
  }

  return params;
}

function fail(error: unknown): Observable<never> {
  return throwError(() => ApiError.from(error));
}
