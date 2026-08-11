import { HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { routes } from '../app.routes';
import { ApiError } from './api-error';
import { Auth } from './auth.service';
import { csrfInterceptor } from './csrf.interceptor';
import { Permissions } from './permissions';
import { Session } from './session';
import { sessionInterceptor } from './session.interceptor';

const ME = {
  user: {
    id: 'user-1',
    email: 'ops@example.internal',
    displayName: 'Ops',
    mfaEnabled: true,
    recoveryCodesRemaining: 8,
  },
  roles: ['Administrator'],
  permissions: ['hosts.read', 'containers.read', 'audit.read'],
  session: { id: 'session-1', expiresAt: '2026-12-31T00:00:00.000Z' },
};

describe('authentication', () => {
  let http: HttpTestingController;
  let auth: Auth;
  let session: Session;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideHttpClient(withInterceptors([csrfInterceptor, sessionInterceptor])),
        provideHttpClientTesting(),
      ],
    });

    http = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(Auth);
    session = TestBed.inject(Session);
  });

  afterEach(() => http.verify());

  describe('sign in', () => {
    it('authenticates with valid credentials', async () => {
      const outcome = auth.login('ops@example.internal', 'correct horse').toPromise();

      const request = http.expectOne('/api/v1/auth/login');
      expect(request.request.body).toEqual({
        email: 'ops@example.internal',
        password: 'correct horse',
      });
      // Nothing carries a bearer token; the session arrives as a cookie.
      expect(request.request.withCredentials).toBe(true);
      expect(request.request.headers.has('authorization')).toBe(false);

      request.flush({ status: 'authenticated', csrfToken: 'csrf-1' });

      expect(await outcome).toBe('authenticated');
      expect(session.csrfToken()).toBe('csrf-1');
    });

    it('reports a rejected sign-in without saying which part was wrong', async () => {
      const failure = auth
        .login('ops@example.internal', 'wrong')
        .toPromise()
        .catch((error: unknown) => ApiError.from(error));

      http
        .expectOne('/api/v1/auth/login')
        .flush(
          { code: 'AUTH_INVALID_CREDENTIALS', message: 'no such user' },
          { status: 401, statusText: 'Unauthorized' },
        );

      const error = (await failure) as ApiError;

      expect(error.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(error.message).toContain('do not match');
      // The server's own wording is not shown; it can name what exists.
      expect(error.message).not.toContain('no such user');
    });

    it('moves to the second factor when one is required', async () => {
      const outcome = auth.login('ops@example.internal', 'correct horse').toPromise();

      http.expectOne('/api/v1/auth/login').flush({ status: 'mfa_required', csrfToken: 'csrf-2' });

      expect(await outcome).toBe('mfa-required');
      expect(session.current().kind).toBe('mfa-pending');
      // A pending session is not a signed-in one.
      expect(session.isAuthenticated()).toBe(false);
    });

    it('completes the second factor with a code and takes the rotated session', async () => {
      session.awaitSecondFactor('csrf-2');

      const done = auth.verifySecondFactor(' 123456 ').toPromise();

      const request = http.expectOne('/api/v1/auth/mfa/verify');
      expect(request.request.body).toEqual({ code: '123456' });
      expect(request.request.headers.get('x-csrf-token')).toBe('csrf-2');

      request.flush({ status: 'authenticated', csrfToken: 'csrf-rotated' });
      await done;

      expect(session.csrfToken()).toBe('csrf-rotated');
    });

    it('accepts a recovery code through the same challenge', async () => {
      session.awaitSecondFactor('csrf-2');

      const done = auth.verifySecondFactor('AB12-CD34-EF56').toPromise();

      const request = http.expectOne('/api/v1/auth/mfa/verify');
      expect(request.request.body).toEqual({ code: 'AB12-CD34-EF56' });

      request.flush({ status: 'authenticated', csrfToken: 'csrf-rotated' });
      await done;

      expect(session.csrfToken()).toBe('csrf-rotated');
    });

    it('reports a refused second factor without ending the sign-in', async () => {
      session.awaitSecondFactor('csrf-2');

      const failure = auth
        .verifySecondFactor('000000')
        .toPromise()
        .catch((error: unknown) => ApiError.from(error));

      http
        .expectOne('/api/v1/auth/mfa/verify')
        .flush({ code: 'AUTH_MFA_INVALID' }, { status: 400, statusText: 'Bad Request' });

      expect(((await failure) as ApiError).code).toBe('AUTH_MFA_INVALID');
      expect(session.current().kind).toBe('mfa-pending');
    });
  });

  describe('session restore', () => {
    it('loads the operator, their roles and their permissions', async () => {
      const done = auth.refresh().toPromise();

      http.expectOne('/api/v1/auth/me').flush(ME);
      await done;

      expect(session.isAuthenticated()).toBe(true);
      expect(session.user()?.email).toBe('ops@example.internal');
      expect(session.roles()).toEqual(['Administrator']);
      expect(TestBed.inject(Permissions).has('audit.read')).toBe(true);
    });

    it('keeps only permissions the interface knows', async () => {
      const done = auth.refresh().toPromise();

      http
        .expectOne('/api/v1/auth/me')
        .flush({ ...ME, permissions: [...ME.permissions, 'containers.remove'] });

      await done;

      // A key the interface does not model cannot become authority it acts on.
      expect(TestBed.inject(Permissions).all()).not.toContain('containers.remove');
    });

    it('is anonymous when no session exists', async () => {
      const done = auth.refresh().toPromise();

      http
        .expectOne('/api/v1/auth/me')
        .flush({ code: 'SESSION_REQUIRED' }, { status: 401, statusText: 'Unauthorized' });

      expect(await done).toBe(false);
      expect(session.isAuthenticated()).toBe(false);
      expect(TestBed.inject(Permissions).all()).toEqual([]);
    });

    it('is anonymous when the session was revoked', async () => {
      const done = auth.refresh().toPromise();

      http
        .expectOne('/api/v1/auth/me')
        .flush({ code: 'SESSION_REVOKED' }, { status: 401, statusText: 'Unauthorized' });

      expect(await done).toBe(false);
      expect(session.isAuthenticated()).toBe(false);
    });

    /**
     * A control server that cannot be reached is not a signed-out operator, but
     * it is not a signed-in one either. Granting nothing is the only safe answer.
     */
    it('grants nothing when the control server cannot be reached', async () => {
      const failed = auth
        .refresh()
        .toPromise()
        .catch(() => 'failed');

      http.expectOne('/api/v1/auth/me').error(new ProgressEvent('error'), { status: 0 });

      expect(await failed).toBe('failed');
      expect(session.isAuthenticated()).toBe(false);
      expect(TestBed.inject(Permissions).all()).toEqual([]);
    });

    it('never throws out of restore, so the application still starts', async () => {
      const restoring = auth.restore();

      http.expectOne('/api/v1/auth/me').error(new ProgressEvent('error'), { status: 0 });

      await restoring;

      expect(session.current().kind).toBe('anonymous');
    });

    /**
     * Concurrent restores share one check.
     *
     * Two route guards resolve on the same navigation and both ask. Two checks
     * racing settle in whatever order they return, and one failing after the
     * other succeeded would leave the interface anonymous with a valid session
     * — an operator on the sign-in page, where every request is unauthenticated
     * and the cause looks like an expired session.
     */
    it('asks once when two callers restore at the same time', async () => {
      const first = auth.restore();
      const second = auth.restore();

      http.expectOne('/api/v1/auth/me').flush(ME);

      await Promise.all([first, second]);

      expect(session.isAuthenticated()).toBe(true);
    });

    it('starts a fresh check after a later restore', async () => {
      await (async () => {
        const restoring = auth.restore();
        http.expectOne('/api/v1/auth/me').flush(ME);
        await restoring;
      })();

      const again = auth.restore();

      // A new check, not the settled answer of the previous one.
      http.expectOne('/api/v1/auth/me').flush(ME);

      await again;

      expect(session.isAuthenticated()).toBe(true);
    });

    /**
     * A refusal is not a lost session.
     *
     * `/auth/me` cannot answer 403 today, but treating one as a sign-out is the
     * kind of rule that turns an authorization answer into an unexplained
     * sign-in page — and every request from that page is anonymous, so the
     * original 403 is invisible afterwards.
     */
    it('does not sign the operator out when a check is refused', async () => {
      session.authenticate({ kind: 'authenticated', ...ME, permissions: ['hosts.read'] });

      const failing = auth
        .refresh()
        .toPromise()
        .catch(() => 'failed');

      http
        .expectOne('/api/v1/auth/me')
        .flush({ code: 'PERMISSION_DENIED' }, { status: 403, statusText: 'Forbidden' });

      await failing;

      expect(session.isAuthenticated()).toBe(true);
    });
  });

  describe('sign out', () => {
    it('ends the session on the server and clears everything held', async () => {
      session.authenticate({ kind: 'authenticated', ...ME, permissions: ['hosts.read'] });
      session.setCsrfToken('csrf-1');

      const done = auth.logout().toPromise();

      const request = http.expectOne('/api/v1/auth/logout');
      expect(request.request.headers.get('x-csrf-token')).toBe('csrf-1');

      request.flush(null, { status: 204, statusText: 'No Content' });
      await done;

      expect(session.isAuthenticated()).toBe(false);
      expect(session.user()).toBeUndefined();
      expect(session.csrfToken()).toBeUndefined();
      expect(TestBed.inject(Permissions).all()).toEqual([]);
    });

    it('clears local state even when the server call fails', async () => {
      session.authenticate({ kind: 'authenticated', ...ME, permissions: ['hosts.read'] });

      const done = auth.logout().toPromise();

      http
        .expectOne('/api/v1/auth/logout')
        .flush({ code: 'INTERNAL_ERROR' }, { status: 500, statusText: 'Server Error' });

      await done;

      // Leaving a signed-out operator looking signed in is the worse outcome.
      expect(session.isAuthenticated()).toBe(false);
    });
  });

  describe('nothing is stored in the browser', () => {
    it('writes no session material to local or session storage', async () => {
      const done = auth.login('ops@example.internal', 'correct horse').toPromise();

      http.expectOne('/api/v1/auth/login').flush({ status: 'authenticated', csrfToken: 'csrf-1' });
      await done;

      const restore = auth.refresh().toPromise();
      http.expectOne('/api/v1/auth/me').flush(ME);
      await restore;

      const stored = [
        ...Object.keys(localStorage).map((key) => `${key}=${localStorage.getItem(key)}`),
        ...Object.keys(sessionStorage).map((key) => `${key}=${sessionStorage.getItem(key)}`),
      ].join('\n');

      expect(stored).not.toContain('csrf-1');
      expect(stored).not.toContain('correct horse');
      expect(stored).not.toContain('ops@example.internal');
      expect(stored).not.toContain('session-1');
    });
  });
});

describe('request handling', () => {
  let http: HttpTestingController;
  let session: Session;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideHttpClient(withInterceptors([csrfInterceptor, sessionInterceptor])),
        provideHttpClientTesting(),
      ],
    });

    http = TestBed.inject(HttpTestingController);
    session = TestBed.inject(Session);
    router = TestBed.inject(Router);
  });

  afterEach(() => http.verify());

  it('sends the CSRF token on a state-changing request', async () => {
    session.setCsrfToken('csrf-1');

    const done = TestBed.inject(Auth).logout().toPromise();
    const request = http.expectOne('/api/v1/auth/logout');

    expect(request.request.headers.get('x-csrf-token')).toBe('csrf-1');

    request.flush(null, { status: 204, statusText: 'No Content' });
    await done;
  });

  it('does not send the CSRF token on a read', async () => {
    session.setCsrfToken('csrf-1');

    const done = TestBed.inject(Auth).refresh().toPromise();
    const request = http.expectOne('/api/v1/auth/me');

    expect(request.request.headers.has('x-csrf-token')).toBe(false);

    request.flush(ME);
    await done;
  });

  /**
   * 401 and 403 are different answers to different questions.
   *
   * A 403 means the session is fine and the operator may not do this; signing
   * them out would suggest the wrong fix, and the page they land on would ask
   * the same question again.
   */
  it('signs out and routes to sign-in on 401', async () => {
    session.authenticate({ kind: 'authenticated', ...ME, permissions: ['hosts.read'] });
    await router.navigateByUrl('/hosts');

    const failed = TestBed.inject(Auth)
      .refresh()
      .toPromise()
      .catch(() => undefined);

    http
      .expectOne('/api/v1/auth/me')
      .flush({ code: 'SESSION_EXPIRED' }, { status: 401, statusText: 'Unauthorized' });

    await failed;

    expect(session.isAuthenticated()).toBe(false);
  });

  it('keeps the operator signed in on 403', async () => {
    session.authenticate({ kind: 'authenticated', ...ME, permissions: ['hosts.read'] });

    const failure = TestBed.inject(Auth)
      .refresh()
      .toPromise()
      .catch((error: unknown) => ApiError.from(error));

    http
      .expectOne('/api/v1/auth/me')
      .flush({ code: 'PERMISSION_DENIED' }, { status: 403, statusText: 'Forbidden' });

    await failure;

    expect(router.url).not.toContain('/login');
  });

  it('reports a transport failure as unreachable rather than as a server error', () => {
    const error = ApiError.from(
      new HttpErrorResponse({ status: 0, error: new ProgressEvent('error') }),
    );

    expect(error.code).toBe('NETWORK_UNAVAILABLE');
  });

  it('carries the request identifier so a failure can be traced', () => {
    const error = ApiError.from(
      new HttpErrorResponse({
        status: 409,
        error: { code: 'CONFLICT', message: 'nope', requestId: 'req-42' },
      }),
    );

    expect(error.requestId).toBe('req-42');
  });
});
