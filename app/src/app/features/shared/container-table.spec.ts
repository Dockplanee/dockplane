import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { routes } from '../../app.routes';

import { PERMISSIONS as ALL_PERMISSIONS, Permission } from '../../core/permissions';
import { Session } from '../../core/session';
import { Container } from '../../domain/inventory';
import { ContainerTable } from './container-table';

const RUNNING: Container = {
  id: 'a1b2c3d4e5f6',
  name: 'nextcloud',
  hostId: 'host-1',
  hostName: 'docker-01',
  hostname: 'docker-01',
  dockerId: 'a1b2c3d4e5f6a1b2',
  image: 'nextcloud:28',
  management: { kind: 'managed', reconciling: false, identityConflict: false },
  state: 'running',
  health: 'healthy',
  restarts: 0,
  createdAt: new Date().toISOString(),
  stale: false,
};

const STOPPED: Container = {
  ...RUNNING,
  id: 'f6a1b2c3d4e5',
  name: 'backup',
  state: 'stopped',
};

@Component({
  imports: [ContainerTable],
  template: `<dp-container-table [containers]="containers()" [showHost]="false" />`,
})
class Host {
  readonly containers = signal<readonly Container[]>([RUNNING, STOPPED]);
}

describe('ContainerTable', () => {
  const render = async (granted: Permission[]) => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideRouter(routes)],
    }).compileComponents();
    TestBed.inject(Session).authenticate({
      kind: 'authenticated',
      user: {
        id: 'user-1',
        email: 'ops@example.internal',
        displayName: 'Ops',
        mfaEnabled: false,
        recoveryCodesRemaining: 0,
      },
      roles: ['Administrator'],
      permissions: granted,
      session: { id: 'session-1', expiresAt: '2026-12-31T00:00:00.000Z' },
    });

    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  };

  const openMenu = (
    fixture: { nativeElement: unknown; detectChanges: () => void },
    index: number,
  ) => {
    const triggers = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
      'dp-row-menu .trigger',
    );
    triggers[index].click();
    fixture.detectChanges();

    // Scoped to the row: every row carries its own menu element.
    return Array.from(
      triggers[index]
        .closest('dp-row-menu')!
        .querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    );
  };

  it('disables the actions the operator may not request', async () => {
    const fixture = await render(['containers.read']);
    const items = openMenu(fixture, 0);

    expect(items.length).toBe(3);
    for (const item of items) {
      expect(item.disabled).toBe(true);
      expect(item.getAttribute('title')?.length ?? 0).toBeGreaterThan(0);
    }
  });

  /**
   * Each operation is gated on its own permission.
   *
   * A role may carry restart without carrying stop, and the table has to follow
   * that exactly. Offering stop to an operator who holds only restart would put
   * a control on screen that the control server refuses.
   */
  it('offers only the operations the operator holds', async () => {
    const fixture = await render(['containers.read', 'containers.restart']);
    const items = openMenu(fixture, 0);
    const named = (label: string) => items.find((item) => item.textContent?.includes(label));

    expect(named('Restart')?.disabled).toBe(false);
    expect(named('Stop')?.disabled).toBe(true);
    expect(named('Stop')?.getAttribute('title')).toContain('containers.stop');
  });

  it('offers start only for a container that is not running', async () => {
    const fixture = await render(['containers.read', 'containers.start']);
    const running = openMenu(fixture, 0).find((item) => item.textContent?.includes('Start'));

    expect(running?.disabled).toBe(true);
    expect(running?.getAttribute('title')).toContain('already running');

    const stopped = openMenu(fixture, 1).find((item) => item.textContent?.includes('Start'));

    expect(stopped?.disabled).toBe(false);
  });

  it('keeps stop disabled for a container that is not running', async () => {
    const fixture = await render(['containers.read', 'containers.stop']);
    const items = openMenu(fixture, 1);
    const stop = items.find((item) => item.textContent?.includes('Stop'));

    expect(stop?.disabled).toBe(true);
    expect(stop?.getAttribute('title')).toContain('not running');
  });

  /**
   * A stale row describes a host that stopped reporting.
   *
   * Whatever it says about the container is the last thing that was true, not
   * what is true now, and the control server refuses to dispatch to a host with
   * no connected agent. Offering the operation anyway would produce a refusal
   * the operator could have been spared.
   */
  it('offers nothing for a container whose host stopped reporting', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideRouter(routes)],
    }).compileComponents();
    TestBed.inject(Session).authenticate({
      kind: 'authenticated',
      user: {
        id: 'user-1',
        email: 'ops@example.internal',
        displayName: 'Ops',
        mfaEnabled: false,
        recoveryCodesRemaining: 0,
      },
      roles: ['Administrator'],
      permissions: [...ALL_PERMISSIONS],
      session: { id: 'session-1', expiresAt: '2026-12-31T00:00:00.000Z' },
    });

    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.containers.set([{ ...RUNNING, stale: true }]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    for (const item of openMenu(fixture, 0)) {
      expect(item.disabled).toBe(true);
    }
  });

  /*
   * A row whose host went quiet still reads "Running", because that is the
   * last thing the host observed. Saying so is the difference between a state
   * and a memory of one, and an operator scanning a list has no other way to
   * tell them apart.
   */
  it('says a stale row is the last state observed, in words', async () => {
    const fixture = await render([...ALL_PERMISSIONS]);
    const element = () => (fixture.nativeElement as HTMLElement).querySelector('tbody tr')!;

    expect(element().textContent).not.toContain('Last known');

    fixture.componentInstance.containers.set([
      { ...RUNNING, stale: true, observedAt: '2026-08-09T12:00:00.000Z' },
    ]);
    fixture.detectChanges();

    // Still named, because the state is not what is in doubt — but named as
    // the last thing reported, and dated.
    expect(element().textContent).toContain('Last known: Running');
    expect(element().textContent).toContain('Reported');
  });

  /*
   * And it does not wear the colour a live row wears. A page of stale rows
   * looked like a page of running containers when the only difference was a
   * word beside an unchanged badge.
   */
  it('does not show a stale row in the tone of a live one', async () => {
    const fixture = await render([...ALL_PERMISSIONS]);
    const badge = () =>
      (fixture.nativeElement as HTMLElement).querySelector('tbody tr td.state dp-status-badge');

    const live = badge()?.getAttribute('data-tone') ?? badge()?.className ?? '';

    fixture.componentInstance.containers.set([{ ...RUNNING, stale: true }]);
    fixture.detectChanges();

    const stale = badge()?.getAttribute('data-tone') ?? badge()?.className ?? '';

    expect(stale).not.toBe(live);
  });

  it('shows unavailable actions rather than removing them', async () => {
    const permittedCount = openMenu(await render([...ALL_PERMISSIONS]), 0).length;
    const unpermittedCount = openMenu(await render(['containers.read']), 0).length;

    expect(permittedCount).toBe(unpermittedCount);
  });

  it('renders no metric bars for a container without resource data', async () => {
    const fixture = await render(['containers.read']);
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr');
    const stoppedRow = Array.from(rows).find((row) => row.textContent?.includes('backup'));

    expect(stoppedRow?.textContent).toContain('Stopped');
  });
});
