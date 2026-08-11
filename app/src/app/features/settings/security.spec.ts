import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { routes } from '../../app.routes';
import { ApiError } from '../../core/api-error';
import { Session } from '../../core/session';
import { DockplaneApi } from '../../data/dockplane-api';
import { OperatorSession } from '../../domain/sessions';
import { signIn } from '../../../testing/harness';
import { TestApi, TestData } from '../../../testing/test-api';
import { Security } from './security';

const SECRET = 'JBSWY3DPEHPK3PXP';
const CODES = ['AAAA-1111', 'BBBB-2222', 'CCCC-3333'];

function session(overrides: Partial<OperatorSession> = {}): OperatorSession {
  return {
    id: 'session-1',
    createdAt: '2026-08-09T10:00:00.000Z',
    lastSeenAt: '2026-08-09T12:00:00.000Z',
    expiresAt: '2026-08-10T00:00:00.000Z',
    userAgent: 'Firefox on Linux',
    sourceIp: '10.0.0.5',
    current: true,
    ...overrides,
  };
}

/**
 * The operator's own security settings.
 *
 * The second factor and the recovery codes are the most sensitive things this
 * interface ever holds. These tests hold it to showing them once and keeping
 * them nowhere.
 */
describe('security settings', () => {
  let api: TestApi;

  const render = async (data: TestData = {}, mfaEnabled = false) => {
    api = new TestApi({
      sessions: [session()],
      mfaSetup: { secret: SECRET, otpauthUrl: `otpauth://totp/Dockplane?secret=${SECRET}` },
      recoveryCodes: CODES,
      ...data,
    });

    await TestBed.configureTestingModule({
      imports: [Security],
      providers: [provideRouter(routes), { provide: DockplaneApi, useValue: api }],
    }).compileComponents();

    signIn(['sessions.read']);

    const current = TestBed.inject(Session);
    const state = current.current();

    if (state.kind === 'authenticated') {
      current.authenticate({
        ...state,
        user: { ...state.user, mfaEnabled, recoveryCodesRemaining: mfaEnabled ? 8 : 0 },
      });
    }

    const fixture = TestBed.createComponent(Security);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    return fixture;
  };

  const host = (fixture: { nativeElement: unknown }) => fixture.nativeElement as HTMLElement;
  const text = (fixture: { nativeElement: unknown }) => host(fixture).textContent ?? '';

  const click = async (fixture: Awaited<ReturnType<typeof render>>, label: string) => {
    const button = Array.from(host(fixture).querySelectorAll('button')).find((element) =>
      element.textContent?.includes(label),
    );

    button?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  const type = async (fixture: Awaited<ReturnType<typeof render>>, value: string) => {
    const input = host(fixture).querySelector<HTMLInputElement>('input[name="code"]')!;

    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
  };

  const submit = async (fixture: Awaited<ReturnType<typeof render>>) => {
    host(fixture).querySelector('form')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  describe('two-factor authentication', () => {
    it('reports that it is not enabled', async () => {
      const fixture = await render();

      expect(text(fixture)).toContain('Not enabled');
      expect(text(fixture)).toContain('Set up two-factor');
    });

    it('reports that it is enabled with the codes remaining', async () => {
      const fixture = await render({}, true);

      expect(text(fixture)).toContain('Enabled');
      expect(text(fixture)).toContain('8 recovery codes remaining');
    });

    it('starts setup and shows the secret to enter by hand', async () => {
      const fixture = await render();

      await click(fixture, 'Set up two-factor');

      expect(api.calls).toContain('beginMfaSetup');
      expect(text(fixture)).toContain(SECRET);
    });

    it('confirms with a code and shows the recovery codes once', async () => {
      const fixture = await render();

      await click(fixture, 'Set up two-factor');
      await type(fixture, '123456');
      await submit(fixture);

      expect(api.calls).toContain('confirmMfa:123456');

      for (const code of CODES) {
        expect(text(fixture)).toContain(code);
      }

      expect(text(fixture)).toContain('will not be shown again');
      // The secret has done its job and is gone before the codes appear.
      expect(text(fixture)).not.toContain(SECRET);
    });

    it('reports a refused code and stays in setup', async () => {
      const fixture = await render({
        failure: new ApiError('AUTH_MFA_INVALID', 'That code was not accepted.', 400),
        failOnly: 'confirmMfa',
      });

      await click(fixture, 'Set up two-factor');
      await type(fixture, '000000');
      await submit(fixture);

      expect(text(fixture)).toContain('not accepted');
      expect(text(fixture)).not.toContain(CODES[0]);
    });

    it('drops the recovery codes when the operator confirms they are saved', async () => {
      const fixture = await render();

      await click(fixture, 'Set up two-factor');
      await type(fixture, '123456');
      await submit(fixture);
      await click(fixture, 'I have saved them');

      expect(text(fixture)).not.toContain(CODES[0]);
    });

    it('keeps neither the secret nor the codes in browser storage', async () => {
      const fixture = await render();

      await click(fixture, 'Set up two-factor');
      await type(fixture, '123456');
      await submit(fixture);

      const stored = [
        ...Object.keys(localStorage).map((key) => `${key}=${localStorage.getItem(key)}`),
        ...Object.keys(sessionStorage).map((key) => `${key}=${sessionStorage.getItem(key)}`),
      ].join('\n');

      expect(stored).not.toContain(SECRET);

      for (const code of CODES) {
        expect(stored).not.toContain(code);
      }
    });

    it('warns that regenerating invalidates the existing codes', async () => {
      const fixture = await render({}, true);

      await click(fixture, 'Regenerate recovery codes');

      expect(text(fixture)).toContain('invalidates all existing recovery codes');
    });

    it('regenerates and shows the new codes once', async () => {
      const fixture = await render({ recoveryCodes: ['NEW-1', 'NEW-2'] }, true);

      await click(fixture, 'Regenerate recovery codes');
      await type(fixture, '123456');
      await submit(fixture);

      expect(api.calls).toContain('regenerateRecoveryCodes:123456');
      expect(text(fixture)).toContain('NEW-1');
    });

    it('warns that disabling signs the operator out everywhere', async () => {
      const fixture = await render({}, true);

      await click(fixture, 'Disable two-factor');

      expect(text(fixture)).toContain('signs you out everywhere');
    });

    it('requires a code to disable and reports a refusal', async () => {
      const fixture = await render(
        {
          failure: new ApiError('AUTH_MFA_INVALID', 'That code was not accepted.', 400),
          failOnly: 'disableMfa',
        },
        true,
      );

      await click(fixture, 'Disable two-factor');
      await type(fixture, '000000');
      await submit(fixture);

      expect(api.calls).toContain('disableMfa:000000');
      expect(text(fixture)).toContain('not accepted');
    });
  });

  describe('sessions', () => {
    it('lists the sessions and marks the current one', async () => {
      const fixture = await render({
        sessions: [session(), session({ id: 'session-2', current: false, userAgent: 'Safari' })],
      });

      expect(text(fixture)).toContain('Firefox on Linux');
      expect(text(fixture)).toContain('Current session');
      expect(text(fixture)).toContain('Safari');
    });

    it('never renders a session token', async () => {
      const fixture = await render();

      // The record is metadata; the token lives in a cookie the browser holds.
      expect(text(fixture)).not.toMatch(/[A-Za-z0-9_-]{32,}/);
    });

    it('revokes another session and reloads the list', async () => {
      const fixture = await render({
        sessions: [session(), session({ id: 'session-2', current: false, userAgent: 'Safari' })],
      });

      const revoke = Array.from(host(fixture).querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Revoke',
      );

      revoke?.click();
      fixture.detectChanges();
      await fixture.whenStable();

      expect(api.calls).toContain('revokeSession:session-2');
    });

    it('offers to end the current session with different wording', async () => {
      const fixture = await render();

      expect(text(fixture)).toContain('Sign out here');
    });

    it('reports a refused revocation without removing the row', async () => {
      const fixture = await render({
        sessions: [session({ id: 'session-2', current: false })],
        failure: new ApiError('PERMISSION_DENIED', 'You do not have permission to do this.', 403),
      });

      await click(fixture, 'Revoke');

      expect(text(fixture)).toContain('do not have permission');
    });
  });
});
