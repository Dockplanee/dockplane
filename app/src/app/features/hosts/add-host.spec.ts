import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { DockplaneApi } from '../../data/dockplane-api';
import { CreatedHostSetup, HostSetup } from '../../domain/operations';
import type { TestData } from '../../../testing/test-api';
import { TestApi } from '../../../testing/test-api';
import { AddHostDialog } from './add-host-dialog';

const TICKET = 'kEyQ3Zt6Xr9wA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU';

const SETUP: CreatedHostSetup = {
  id: '2f1a6c1e-6b3f-4a0e-9d0e-4f0f9f2b7c11',
  displayName: 'web-01',
  status: 'waiting',
  progress: { bootstrapped: false, enrolled: false, connected: false, inventoryReported: false },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  hostId: null,
  ticket: TICKET,
};

function connected(): HostSetup {
  return {
    ...SETUP,
    status: 'connected',
    progress: { bootstrapped: true, enrolled: true, connected: true, inventoryReported: true },
    hostId: '9a0b1c2d-3e4f-5061-7283-94a5b6c7d8e9',
  };
}

/**
 * Adding a host.
 *
 * The properties worth holding: the command carries the ticket in a body and
 * not in an address, the visible command never contains an enrollment token,
 * and the waiting view reports only what the server said it observed.
 */
describe('add host', () => {
  let fixture: ComponentFixture<AddHostDialog>;
  let api: TestApi;

  const render = async (data: TestData = {}) => {
    api = new TestApi(data);

    TestBed.configureTestingModule({
      imports: [AddHostDialog],
      providers: [provideRouter([]), { provide: DockplaneApi, useValue: api }],
    });

    fixture = TestBed.createComponent(AddHostDialog);
    fixture.detectChanges();
    await fixture.whenStable();
  };

  const text = () => fixture.nativeElement.textContent as string;
  const command = () =>
    (fixture.nativeElement.querySelector('[data-testid="install-command"]')?.textContent ??
      '') as string;

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('asks for a name before it mints anything', async () => {
    await render({ hostSetup: SETUP });

    fixture.componentInstance.open();
    fixture.detectChanges();

    expect(text()).toContain('Name (optional)');
    expect(api.calls).toEqual([]);
  });

  it('shows a command that carries the ticket in the request body', async () => {
    await render({ hostSetup: SETUP });

    fixture.componentInstance.open();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const shown = command();

    expect(shown).toContain(TICKET);
    expect(shown).toContain('/api/v1/host-setups/bootstrap');
    expect(shown).toContain('--data-binary @-');

    // The ticket is in the body. Nothing puts it in the path or the query,
    // where every proxy and access log on the way would record it.
    expect(shown).not.toContain(`bootstrap/${TICKET}`);
    expect(shown).not.toContain(`?ticket=`);
    expect(shown).not.toContain(`${TICKET}/`);
  });

  it('never shows an enrollment token', async () => {
    await render({ hostSetup: SETUP });

    fixture.componentInstance.open();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(command()).not.toContain('--token');
    expect(command()).not.toContain('enroll');
  });

  it('says the command is one-time and when it expires', async () => {
    await render({ hostSetup: SETUP });

    fixture.componentInstance.open();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(text()).toContain('One command, once');
    expect(text()).toContain('Expires in');
  });

  it('reports only the steps the server has observed', async () => {
    await render({ hostSetup: SETUP, hostSetupState: SETUP });

    fixture.componentInstance.open();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const done = fixture.nativeElement.querySelectorAll('.steps li.done');

    expect(done.length).toBe(0);
    expect(text()).toContain('Command run on the host');
    expect(text()).toContain('Docker inventory received');
  });

  it('surfaces a refusal rather than pretending a command exists', async () => {
    await render({});

    fixture.componentInstance.open();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(text()).toContain('Not permitted');
    expect(command()).toBe('');
  });

  it('replaces the command when a new one is asked for', async () => {
    const replacement: CreatedHostSetup = { ...SETUP, ticket: 'zZz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp' };

    await render({ hostSetup: SETUP, regeneratedHostSetup: replacement });

    fixture.componentInstance.open();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ) as HTMLButtonElement[];
    buttons.find((button) => button.textContent?.includes('New command'))!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(command()).toContain(replacement.ticket);
    expect(command()).not.toContain(TICKET);
  });

  it('holds nothing once it is closed', async () => {
    await render({ hostSetup: SETUP });

    fixture.componentInstance.open();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(command()).toContain(TICKET);

    fixture.componentInstance.close();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain(TICKET);
  });

  it('offers the host once the server reports it connected', async () => {
    await render({ hostSetup: { ...SETUP }, hostSetupState: connected() });

    fixture.componentInstance.open();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // The poll is what advances the view; nothing here moves on its own.
    await new Promise((resolve) => setTimeout(resolve, 3200));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(text()).toContain('is connected');
    expect(text()).toContain('Open host');
  });
});
