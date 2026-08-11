import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { routes } from '../../app.routes';
import { ApiError } from '../../core/api-error';
import { DockplaneApi } from '../../data/dockplane-api';
import { signIn } from '../../../testing/harness';
import { TestApi, TestData } from '../../../testing/test-api';
import { EnrollmentDialog } from './enrollment-dialog';

const TOKEN = 'ENROLL-TOKEN-cnVubmluZy1vbmNl';

/**
 * Issuing an enrollment token.
 *
 * The raw value is shown once and is never recoverable: the server keeps only a
 * digest. These tests hold the interface to the same promise — nothing written
 * to storage, nothing left in the component once the dialog closes, and no
 * command that would put the token where a shell records it.
 */
describe('enrollment', () => {
  let api: TestApi;

  const render = async (data: TestData = {}, permissions: 'enroll' | 'none' = 'enroll') => {
    api = new TestApi({
      enrollmentToken: { id: 'token-1', token: TOKEN, expiresAt: expiry() },
      ...data,
    });

    await TestBed.configureTestingModule({
      imports: [EnrollmentDialog],
      providers: [provideRouter(routes), { provide: DockplaneApi, useValue: api }],
    }).compileComponents();

    signIn(permissions === 'enroll' ? ['agents.read', 'agents.enroll'] : ['agents.read']);

    const fixture = TestBed.createComponent(EnrollmentDialog);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    return fixture;
  };

  const text = (fixture: { nativeElement: unknown }) =>
    (fixture.nativeElement as HTMLElement).textContent ?? '';

  const create = async (fixture: Awaited<ReturnType<typeof render>>) => {
    fixture.componentInstance.open();
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement)
      .querySelector('form')!
      .dispatchEvent(new Event('submit'));

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('asks the control server for a token', async () => {
    const fixture = await render();

    await create(fixture);

    expect(api.calls).toContain('createEnrollmentToken');
    expect(text(fixture)).toContain(TOKEN);
  });

  it('says the token will not be shown again', async () => {
    const fixture = await render();

    await create(fixture);

    expect(text(fixture)).toContain('will not be shown again');
  });

  it('shows when the token expires', async () => {
    const fixture = await render();

    await create(fixture);

    expect(text(fixture)).toContain('Expires');
  });

  /**
   * The agent deliberately has no `--token` flag: a command line is visible in
   * the process list and is written to the shell history. The interface must
   * not undo that by suggesting one.
   */
  it('suggests a command that does not carry the token as an argument', async () => {
    const fixture = await render();

    await create(fixture);

    const command = (fixture.nativeElement as HTMLElement).querySelector('pre')?.textContent ?? '';

    expect(command).toContain('--token-stdin');
    expect(command).not.toContain('--token ');
    expect(command).not.toContain(TOKEN);
  });

  it('writes the token nowhere the browser can read it back', async () => {
    const fixture = await render();

    await create(fixture);

    const stored = [
      ...Object.keys(localStorage).map((key) => `${key}=${localStorage.getItem(key)}`),
      ...Object.keys(sessionStorage).map((key) => `${key}=${sessionStorage.getItem(key)}`),
    ].join('\n');

    expect(stored).not.toContain(TOKEN);
    expect(location.href).not.toContain(TOKEN);
  });

  it('drops the token when the dialog closes', async () => {
    const fixture = await render();

    await create(fixture);
    expect(text(fixture)).toContain(TOKEN);

    fixture.componentInstance.close();
    fixture.detectChanges();

    expect(text(fixture)).not.toContain(TOKEN);
  });

  it('does not bring the token back when the dialog is opened again', async () => {
    const fixture = await render();

    await create(fixture);
    fixture.componentInstance.close();

    fixture.componentInstance.open();
    fixture.detectChanges();

    expect(text(fixture)).not.toContain(TOKEN);
  });

  it('reports a refusal instead of showing a token', async () => {
    const fixture = await render({
      failure: new ApiError('PERMISSION_DENIED', 'You do not have permission to do this.', 403),
      enrollmentToken: undefined,
    });

    await create(fixture);

    expect(text(fixture)).toContain('do not have permission');
    expect(text(fixture)).not.toContain(TOKEN);
  });

  it('does not send a second request while one is in flight', async () => {
    const fixture = await render();

    fixture.componentInstance.open();
    fixture.detectChanges();

    const form = (fixture.nativeElement as HTMLElement).querySelector('form')!;

    form.dispatchEvent(new Event('submit'));
    form.dispatchEvent(new Event('submit'));

    fixture.detectChanges();
    await fixture.whenStable();

    expect(api.calls.filter((call) => call === 'createEnrollmentToken')).toHaveLength(1);
  });
});

function expiry(): string {
  return new Date(Date.now() + 10 * 60 * 1000).toISOString();
}
