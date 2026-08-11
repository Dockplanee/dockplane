import { Injectable, computed, signal } from '@angular/core';

import { Permission } from './permissions';

export interface SignedInUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly mfaEnabled: boolean;
  readonly recoveryCodesRemaining: number;
}

export interface SessionInfo {
  readonly id: string;
  readonly expiresAt: string;
}

/** What the interface knows about the current sign-in. */
export type SessionState =
  /** The session has not been checked yet; nothing protected may render. */
  | { readonly kind: 'unknown' }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'mfa-pending' }
  | {
      readonly kind: 'authenticated';
      readonly user: SignedInUser;
      readonly roles: readonly string[];
      readonly permissions: readonly Permission[];
      readonly session: SessionInfo;
    };

/**
 * The signed-in session, held in memory only.
 *
 * Nothing here is written to `localStorage` or `sessionStorage`. The session
 * itself lives in an HttpOnly cookie the browser cannot read, and the CSRF
 * token is a value this tab holds for as long as it is open. Persisting either
 * would put a credential somewhere script on the page can reach it.
 */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly state = signal<SessionState>({ kind: 'unknown' });

  /**
   * The CSRF token for state-changing requests.
   *
   * Issued at sign-in and rotated when the second factor completes. It is not a
   * bearer token: without the session cookie it authorises nothing.
   */
  private readonly csrf = signal<string | undefined>(undefined);

  readonly current = this.state.asReadonly();

  readonly isAuthenticated = computed(() => this.state().kind === 'authenticated');

  /** True until the first session check completes, so guards can wait. */
  readonly isResolving = computed(() => this.state().kind === 'unknown');

  readonly user = computed(() => {
    const state = this.state();

    return state.kind === 'authenticated' ? state.user : undefined;
  });

  readonly roles = computed(() => {
    const state = this.state();

    return state.kind === 'authenticated' ? state.roles : [];
  });

  /**
   * The permissions the control server granted.
   *
   * Empty for anyone who is not authenticated. There is no default set and no
   * fallback: a permission the server did not grant is a permission the
   * interface does not have.
   */
  readonly permissions = computed<readonly Permission[]>(() => {
    const state = this.state();

    return state.kind === 'authenticated' ? state.permissions : [];
  });

  readonly csrfToken = this.csrf.asReadonly();

  authenticate(state: Extract<SessionState, { kind: 'authenticated' }>): void {
    this.state.set(state);
  }

  awaitSecondFactor(csrfToken: string): void {
    this.csrf.set(csrfToken);
    this.state.set({ kind: 'mfa-pending' });
  }

  setCsrfToken(token: string): void {
    this.csrf.set(token);
  }

  anonymous(): void {
    this.state.set({ kind: 'anonymous' });
    this.csrf.set(undefined);
  }

  /** Returns to the unresolved state, used when a session check must run again. */
  reset(): void {
    this.state.set({ kind: 'unknown' });
    this.csrf.set(undefined);
  }
}
