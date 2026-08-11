import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { routes } from '../app.routes';
import { Permission } from './permissions';
import { Session } from './session';

const ME = {
  user: {
    id: 'user-1',
    email: 'ops@example.internal',
    displayName: 'Ops',
    mfaEnabled: false,
    recoveryCodesRemaining: 0,
  },
  roles: ['Read Only'],
  session: { id: 'session-1', expiresAt: '2026-12-31T00:00:00.000Z' },
};

/**
 * Route protection.
 *
 * The guards are exercised through real navigation rather than by calling them
 * directly, because what matters is where an operator ends up: the session
 * check has to finish before a protected component is created, and a missing
 * permission must not look like a missing session.
 */
describe('route protection', () => {
  let http: HttpTestingController;
  let router: Router;
  let session: Session;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting()],
    });

    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    session = TestBed.inject(Session);
  });

  afterEach(() => http.verify({ ignoreCancelled: true }));

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * Answers the session check a guard makes, once it has actually been sent.
   *
   * The guard awaits the request and the router awaits the guard, so the test
   * has to let those turns run rather than flushing immediately. A session that
   * is already resolved makes no request, which is not a failure.
   */
  const answerSessionCheck = async (permissions?: readonly Permission[]) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await tick();

      const pending = http.match('/api/v1/auth/me');

      if (pending.length === 0) {
        continue;
      }

      for (const request of pending) {
        if (permissions) {
          request.flush({ ...ME, permissions });
        } else {
          request.flush({ code: 'SESSION_REQUIRED' }, { status: 401, statusText: 'Unauthorized' });
        }
      }

      return;
    }
  };

  const navigate = async (url: string, permissions?: readonly Permission[]) => {
    const navigation = router.navigateByUrl(url);

    await answerSessionCheck(permissions);
    await navigation;

    return router.url;
  };

  it('sends an unauthenticated visitor to sign in, keeping where they were going', async () => {
    const url = await navigate('/hosts');

    expect(url).toContain('/login');
    expect(url).toContain('returnUrl=%2Fhosts');
  });

  it('admits an operator who holds the permission', async () => {
    expect(await navigate('/hosts', ['hosts.read'])).toBe('/hosts');
  });

  /**
   * A missing permission is an authorization answer, not a session problem. The
   * operator stays signed in and sees why, rather than being asked to sign in
   * again for a session that is perfectly valid.
   */
  it('sends an operator without the permission to the forbidden page', async () => {
    const url = await navigate('/audit', ['hosts.read']);

    expect(url).toContain('/forbidden');
    expect(url).not.toContain('/login');
    expect(session.isAuthenticated()).toBe(true);
  });

  it('keeps a signed-in operator away from the sign-in page', async () => {
    expect(await navigate('/login', ['hosts.read'])).toBe('/overview');
  });

  it('lets an unauthenticated visitor reach the sign-in page', async () => {
    expect(await navigate('/login')).toBe('/login');
  });

  it('resolves the session before a protected route activates', async () => {
    const navigation = router.navigateByUrl('/hosts');

    await tick();

    // Still undecided while the control server has not answered, so nothing
    // protected can have rendered yet.
    expect(session.isResolving()).toBe(true);

    await answerSessionCheck(['hosts.read']);
    await navigation;

    expect(session.isResolving()).toBe(false);
    expect(router.url).toBe('/hosts');
  });

  it('checks the session once for a deep link rather than per guard', async () => {
    const navigation = router.navigateByUrl('/audit');

    let sent = 0;

    for (let attempt = 0; attempt < 20 && sent === 0; attempt += 1) {
      await tick();

      const pending = http.match('/api/v1/auth/me');
      sent = pending.length;

      for (const request of pending) {
        request.flush({ ...ME, permissions: ['audit.read'] });
      }
    }

    await navigation;

    expect(sent).toBe(1);
  });

  it('does not loop between sign-in and the forbidden page', async () => {
    const url = await navigate('/users', ['hosts.read']);

    expect(url).toContain('/forbidden');

    // Landing on the forbidden page must not itself be refused.
    const settled = router.url;
    expect(settled).toContain('/forbidden');
  });
});
