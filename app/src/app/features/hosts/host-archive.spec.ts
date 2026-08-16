import { ApiError } from '../../core/api-error';
import { host } from '../../../testing/data';
import { DockplaneApi } from '../../data/dockplane-api';
import { renderView } from '../../../testing/harness';
import { TestApi, TestData } from '../../../testing/test-api';
import { TestBed } from '@angular/core/testing';
import { ContainerCreate } from '../containers/container-create';
import { HostDetail } from './host-detail';
import { HostList } from './host-list';

/**
 * Archiving a host, from the side an operator sees.
 *
 * The two things these hold in place are that an archived host leaves the
 * working lists without leaving the product, and that nothing here decides
 * whether the action is allowed — the control server does, and a refusal is
 * shown rather than pre-empted.
 */

const active = host({ id: 'host-active', name: 'Frankfurt 1', hostname: 'shared-01' });

const archived = host({
  id: 'host-archived',
  name: 'Frankfurt 1 (superseded)',
  hostname: 'shared-01',
  status: 'offline',
  archived: true,
  archivedAt: '2026-08-16T10:00:00.000Z',
});

async function render(data: TestData, permissions: string[] = ['hosts.read', 'hosts.archive']) {
  const fixture = await renderView(HostList, {
    data,
    permissions: permissions as never,
  });

  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();

  return fixture;
}

const scopeSelect = (fixture: { nativeElement: unknown }) =>
  (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>(
    'dp-select-filter#host-scope select',
  );

const rowNames = (fixture: { nativeElement: unknown }) =>
  [...(fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr th')].map((cell) =>
    cell.textContent?.trim(),
  );

describe('the hosts list', () => {
  it('shows the working set and not what was archived', async () => {
    const fixture = await render({ hosts: [active, archived] });

    expect(rowNames(fixture).join(' ')).toContain('Frankfurt 1');
    expect(rowNames(fixture).join(' ')).not.toContain('superseded');
  });

  it('offers a way to see the archived ones', async () => {
    const fixture = await render({ hosts: [active, archived] });
    const select = scopeSelect(fixture);

    expect(select).not.toBeNull();
    expect([...(select?.options ?? [])].map((option) => option.value)).toEqual([
      'active',
      'archived',
      'all',
    ]);
  });

  it('shows the archived ones when asked, and marks them', async () => {
    const fixture = await render({ hosts: [active, archived] });

    fixture.componentInstance['scope'].set('archived');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('superseded');
    expect(text).toContain('Archived');
    expect(rowNames(fixture)).toHaveLength(1);
    expect(rowNames(fixture)[0]).toContain('superseded');
  });

  it('shows both when asked for all', async () => {
    const fixture = await render({ hosts: [active, archived] });

    fixture.componentInstance['scope'].set('all');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(rowNames(fixture)).toHaveLength(2);
  });

  it('asks the server for the scope rather than filtering what it holds', async () => {
    const fixture = await render({ hosts: [active, archived] });
    const api = TestBed.inject(DockplaneApi) as TestApi;

    fixture.componentInstance['scope'].set('archived');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(api.calls).toContain('hosts:archived');
  });

  describe('the row action', () => {
    it('offers archiving for a host that is not connected', async () => {
      const fixture = await render({ hosts: [host({ id: 'h', status: 'offline' })] });
      const actions = fixture.componentInstance['actionsFor'](host({ status: 'offline' }));

      expect(actions.map((action) => action.id)).toEqual(['archive']);
      expect(actions[0].disabled).toBe(false);
    });

    // The button is not the authority; it just does not invite a refusal.
    it('offers it disabled while the host is reporting', async () => {
      const fixture = await render({ hosts: [active] });
      const actions = fixture.componentInstance['actionsFor'](host({ status: 'healthy' }));

      expect(actions[0].disabled).toBe(true);
      expect(actions[0].hint).toContain('connected agent');
    });

    it('offers restoring for an archived host', async () => {
      const fixture = await render({ hosts: [archived] });
      const actions = fixture.componentInstance['actionsFor'](archived);

      expect(actions.map((action) => action.id)).toEqual(['unarchive']);
    });

    it('offers nothing without the permission', async () => {
      const fixture = await render({ hosts: [active] }, ['hosts.read']);

      expect(fixture.componentInstance['actionsFor'](active)).toEqual([]);
    });
  });

  describe('archiving', () => {
    it('says what will and will not happen before doing it', async () => {
      const fixture = await render({ hosts: [host({ id: 'h', status: 'offline' })] });

      fixture.componentInstance['run'](host({ id: 'h', status: 'offline' }), 'archive');
      fixture.detectChanges();

      // The add-host dialog is also on this page; the confirmation is the open one.
      const dialog = (fixture.nativeElement as HTMLElement).querySelector('dialog[open]');
      const text = dialog?.textContent ?? '';

      expect(text).toContain('stay exactly as they are');
      expect(text).toContain('restore it at any time');
      expect(text).not.toContain('cannot be undone');
    });

    it('sends the request when confirmed', async () => {
      const target = host({ id: 'h', status: 'offline' });
      const fixture = await render({ hosts: [target] });
      const api = TestBed.inject(DockplaneApi) as TestApi;

      fixture.componentInstance['run'](target, 'archive');
      fixture.componentInstance['confirmArchive']();
      await fixture.whenStable();

      expect(api.calls).toContain('archiveHost:h');
    });

    /*
     * The refusal the server exists to give: an agent reconnected between the
     * page rendering and the request arriving.
     */
    it('shows the refusal when the host turns out to be in use', async () => {
      const target = host({ id: 'h', status: 'offline' });
      const fixture = await render({
        hosts: [target],
        archiveFailure: new ApiError(
          'HOST_CONNECTED',
          'The host has a connected agent, so it is in use and cannot be archived.',
          409,
        ),
      });

      fixture.componentInstance['run'](target, 'archive');
      fixture.componentInstance['confirmArchive']();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.componentInstance['failure']()?.message).toContain('connected agent');
    });
  });

  it('restores an archived host without a confirmation', async () => {
    const fixture = await render({ hosts: [archived] });
    const api = TestBed.inject(DockplaneApi) as TestApi;

    fixture.componentInstance['run'](archived, 'unarchive');
    await fixture.whenStable();

    expect(api.calls).toContain('unarchiveHost:host-archived');
  });
});

describe('the host detail of an archived host', () => {
  it('reads it, says it is archived, and does not report it missing', async () => {
    const fixture = await renderView(HostDetail, {
      params: { id: archived.id },
      permissions: ['hosts.read'],
      data: { hosts: [archived] },
    });

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('Frankfurt 1 (superseded)');
    expect(text).toContain('Archived');
    expect(text).toContain('still recorded here');
    expect(text).not.toContain('not found');
  });
});

describe('the host selectors', () => {
  it('do not offer an archived host as somewhere to create a container', async () => {
    const fixture = await renderView(ContainerCreate, {
      permissions: ['containers.create', 'hosts.read'],
      data: { hosts: [active, archived] },
    });

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('Frankfurt 1');
    expect(text).not.toContain('superseded');
  });
});
