import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { routes } from '../../app.routes';
import { csrfInterceptor } from '../../core/csrf.interceptor';
import { Session } from '../../core/session';
import { sessionInterceptor } from '../../core/session.interceptor';
import { Login } from './login';

const ME = {
  user: {
    id: 'user-1',
    email: 'ops@example.internal',
    displayName: 'Ops',
    mfaEnabled: true,
    recoveryCodesRemaining: 8,
  },
  roles: ['Administrator'],
  permissions: ['hosts.read'],
  session: { id: 'session-1', expiresAt: '2026-12-31T00:00:00.000Z' },
};

describe('Login', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<Login>;

  const render = async (queryParams: Record<string, string> = {}) => {
    await TestBed.configureTestingModule({
      imports: [Login],
      providers: [
        provideRouter(routes),
        provideHttpClient(withInterceptors([csrfInterceptor, sessionInterceptor])),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: {
            queryParamMap: of({ get: (key: string) => queryParams[key] ?? null }),
            snapshot: { queryParamMap: { get: (key: string) => queryParams[key] ?? null } },
          },
        },
      ],
    }).compileComponents();

    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    return fixture;
  };

  const host = () => fixture.nativeElement as HTMLElement;

  const type = (selector: string, value: string) => {
    const input = host().querySelector<HTMLInputElement>(selector)!;

    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  const submit = async () => {
    host().querySelector('form')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
  };

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    // The sign-in flow finishes through a promise chain of its own, which
    // stability does not wait for.
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
  };

  afterEach(() => http.verify({ ignoreCancelled: true }));

  it('asks for an email address and a password', async () => {
    await render();

    expect(host().querySelector('input[type="email"]')).not.toBeNull();
    expect(host().querySelector('input[type="password"]')).not.toBeNull();
  });

  it('signs in and continues to the requested page', async () => {
    await render({ returnUrl: '/hosts' });
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl');

    type('input[type="email"]', 'ops@example.internal');
    type('input[type="password"]', 'correct horse');
    await submit();

    http.expectOne('/api/v1/auth/login').flush({ status: 'authenticated', csrfToken: 'csrf-1' });
    await settle();

    http.expectOne('/api/v1/auth/me').flush(ME);
    await settle();

    expect(navigate).toHaveBeenCalledWith('/hosts');
  });

  it('shows a failure without naming which credential was wrong', async () => {
    await render();

    type('input[type="email"]', 'ops@example.internal');
    type('input[type="password"]', 'wrong');
    await submit();

    http
      .expectOne('/api/v1/auth/login')
      .flush(
        { code: 'AUTH_INVALID_CREDENTIALS', message: 'user not found' },
        { status: 401, statusText: 'Unauthorized' },
      );

    await settle();

    const text = host().textContent ?? '';

    expect(text).toContain('do not match');
    expect(text).not.toContain('user not found');
  });

  it('asks for the second factor when the server requires one', async () => {
    await render();

    type('input[type="email"]', 'ops@example.internal');
    type('input[type="password"]', 'correct horse');
    await submit();

    http.expectOne('/api/v1/auth/login').flush({ status: 'mfa_required', csrfToken: 'csrf-2' });
    await settle();

    expect(host().textContent).toContain('Two-factor authentication');
    expect(host().querySelector('input[name="code"]')).not.toBeNull();
    // The password field is gone, and with it what was typed into it.
    expect(host().querySelector('input[type="password"]')).toBeNull();
  });

  it('completes the second factor and loads the session', async () => {
    await render();

    type('input[type="email"]', 'ops@example.internal');
    type('input[type="password"]', 'correct horse');
    await submit();

    http.expectOne('/api/v1/auth/login').flush({ status: 'mfa_required', csrfToken: 'csrf-2' });
    await settle();

    type('input[name="code"]', '123456');
    await submit();

    const verify = http.expectOne('/api/v1/auth/mfa/verify');
    expect(verify.request.headers.get('x-csrf-token')).toBe('csrf-2');

    verify.flush({ status: 'authenticated', csrfToken: 'csrf-rotated' });
    await settle();

    http.expectOne('/api/v1/auth/me').flush(ME);
    await settle();

    expect(TestBed.inject(Session).isAuthenticated()).toBe(true);
  });

  it('accepts a recovery code in the same field', async () => {
    await render();

    type('input[type="email"]', 'ops@example.internal');
    type('input[type="password"]', 'correct horse');
    await submit();

    http.expectOne('/api/v1/auth/login').flush({ status: 'mfa_required', csrfToken: 'csrf-2' });
    await settle();

    type('input[name="code"]', 'AB12-CD34-EF56');
    await submit();

    const verify = http.expectOne('/api/v1/auth/mfa/verify');
    expect(verify.request.body).toEqual({ code: 'AB12-CD34-EF56' });

    verify.flush({ status: 'authenticated', csrfToken: 'csrf-rotated' });
    await settle();

    http.expectOne('/api/v1/auth/me').flush(ME);
    await settle();
  });

  it('reports a refused code and stays on the challenge', async () => {
    await render();

    type('input[type="email"]', 'ops@example.internal');
    type('input[type="password"]', 'correct horse');
    await submit();

    http.expectOne('/api/v1/auth/login').flush({ status: 'mfa_required', csrfToken: 'csrf-2' });
    await settle();

    type('input[name="code"]', '000000');
    await submit();

    http
      .expectOne('/api/v1/auth/mfa/verify')
      .flush({ code: 'AUTH_MFA_INVALID' }, { status: 400, statusText: 'Bad Request' });

    await settle();

    expect(host().textContent).toContain('not accepted');
    expect(host().querySelector('input[name="code"]')).not.toBeNull();
  });

  it('shows the request identifier when the server supplies one', async () => {
    await render();

    type('input[type="email"]', 'ops@example.internal');
    type('input[type="password"]', 'x');
    await submit();

    http
      .expectOne('/api/v1/auth/login')
      .flush(
        { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'req-42' },
        { status: 500, statusText: 'Server Error' },
      );

    await settle();

    expect(host().textContent).toContain('req-42');
  });

  it('ignores a return address that points off the application', async () => {
    await render({ returnUrl: 'https://example.com/phish' });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');

    type('input[type="email"]', 'ops@example.internal');
    type('input[type="password"]', 'correct horse');
    await submit();

    http.expectOne('/api/v1/auth/login').flush({ status: 'authenticated', csrfToken: 'csrf-1' });
    await settle();

    http.expectOne('/api/v1/auth/me').flush(ME);
    await settle();

    expect(navigate).toHaveBeenCalledWith('/overview');
  });
});
