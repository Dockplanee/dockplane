import { Injectable, inject } from '@angular/core';
import { Observable, catchError, firstValueFrom, map, of, tap, throwError } from 'rxjs';

import { ApiClient, anonymousRequest } from './api-client';
import { ApiError } from './api-error';
import { toPermissions } from './permissions';
import { Session, SignedInUser } from './session';

interface LoginResponse {
  readonly status: 'authenticated' | 'mfa_required';
  readonly csrfToken: string;
}

interface MeResponse {
  /** Reissued on every restore; only its digest is stored server-side. */
  readonly csrfToken: string;
  readonly user: SignedInUser;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly session: { readonly id: string; readonly expiresAt: string };
}

/** What a sign-in attempt produced, for the page that started it. */
export type LoginOutcome = 'authenticated' | 'mfa-required';

/**
 * Sign-in, the second factor, session restore and sign-out.
 *
 * The session lives in an HttpOnly cookie the browser manages. Nothing here
 * stores a credential: the interface holds the CSRF token in memory for as long
 * as the tab is open, and everything else comes back from the server on
 * request.
 */
@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly api = inject(ApiClient);
  private readonly session = inject(Session);

  /**
   * The session check that is currently in flight, if any.
   *
   * Two route guards resolve on the same navigation, and both ask whether the
   * session is still being resolved. Without this they each start a check, and
   * the answers are applied in whatever order they return: one failing for a
   * transient reason after the other succeeded leaves the interface anonymous
   * while the session is perfectly valid — which puts an operator on the sign-in
   * page and makes every request from it unauthenticated.
   */
  private restoring?: Promise<void>;

  /**
   * Signs in with a password.
   *
   * A rejected attempt says only that the credentials do not match. The server
   * deliberately does not distinguish an unknown address from a wrong password,
   * and the interface must not invent that distinction either.
   */
  login(email: string, password: string): Observable<LoginOutcome> {
    return this.api
      .post<LoginResponse>('/api/v1/auth/login', { email, password }, anonymousRequest())
      .pipe(
        tap((response) => this.session.setCsrfToken(response.csrfToken)),
        // Signing in changes who is asking, so a check begun before it can no
        // longer answer for the session that now exists.
        tap(() => this.forgetRestore()),
        map((response) => (response.status === 'mfa_required' ? 'mfa-required' : 'authenticated')),
        tap((outcome) => {
          if (outcome === 'mfa-required') {
            this.session.awaitSecondFactor(this.session.csrfToken()!);
          }
        }),
      );
  }

  /**
   * Completes a sign-in that required a second factor.
   *
   * The same endpoint accepts a time-based code and a recovery code; which one
   * was used is the server's business, so the interface sends what was typed.
   */
  verifySecondFactor(code: string): Observable<void> {
    return this.api.post<LoginResponse>('/api/v1/auth/mfa/verify', { code: code.trim() }).pipe(
      tap((response) => this.session.setCsrfToken(response.csrfToken)),
      // The session is rotated by the second factor; anything in flight was
      // asking about the one that has just been replaced.
      tap(() => this.forgetRestore()),
      map(() => undefined),
    );
  }

  /**
   * Loads the signed-in operator, their roles and their permissions.
   *
   * This is the only source of permissions. A failure leaves the session
   * anonymous rather than partially populated, so the interface offers nothing
   * instead of guessing at authority the server never confirmed.
   */
  refresh(): Observable<boolean> {
    return this.api.get<MeResponse>('/api/v1/auth/me').pipe(
      tap((response) => this.session.setCsrfToken(response.csrfToken)),
      tap((response) =>
        this.session.authenticate({
          kind: 'authenticated',
          user: response.user,
          roles: response.roles,
          permissions: toPermissions(response.permissions),
          session: response.session,
        }),
      ),
      map(() => true),
      catchError((error: unknown) => {
        const failure = ApiError.from(error);

        /*
         * Only 401 means the session is the problem.
         *
         * A 403 is an answer about authority, not about identity. Treating one
         * as a lost session would sign an operator out for asking about
         * something they may not have — and on the sign-in page that follows,
         * every request is anonymous, so the cause of the sign-out looks like
         * the session having expired.
         */
        if (failure.status === 401) {
          this.session.anonymous();
          return of(false);
        }

        /*
         * A check that produced no usable answer — no response at all, or a
         * server error — cannot be trusted with protected content either, so
         * the interface grants nothing. Any other refusal is an answer: it is
         * reported, and what the operator already holds is left alone.
         */
        if (failure.status === 0 || failure.status >= 500) {
          this.session.anonymous();
        }

        return throwError(() => failure);
      }),
    );
  }

  /**
   * Restores the session at start-up. Never throws; the app must still load.
   *
   * Concurrent callers share one check. Guards run in parallel on a navigation,
   * and two checks racing can settle in the wrong order.
   */
  async restore(): Promise<void> {
    this.restoring ??= this.runRestore();

    return this.restoring;
  }

  /** Drops an in-flight check whose answer would be about a former session. */
  private forgetRestore(): void {
    this.restoring = undefined;
  }

  private async runRestore(): Promise<void> {
    try {
      await firstValueFrom(this.refresh());
    } catch {
      this.session.anonymous();
    } finally {
      this.restoring = undefined;
    }
  }

  /**
   * Signs out.
   *
   * The server revokes the session; the interface then forgets everything it
   * held. Local state is cleared even when the call fails, because leaving a
   * signed-out operator looking signed in is the worse outcome.
   */
  logout(): Observable<void> {
    return this.api.post<void>('/api/v1/auth/logout').pipe(
      catchError(() => of(undefined)),
      tap(() => this.session.anonymous()),
      map(() => undefined),
    );
  }
}
