import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { throwError } from 'rxjs';

import { DockplaneApi } from '../../data/dockplane-api';
import { container, host } from '../../../testing/data';
import { element, renderView, textOf } from '../../../testing/harness';
import { TestApi } from '../../../testing/test-api';
import { ContainerList } from '../containers/container-list';

/**
 * The quick actions on a container list.
 *
 * They go through the same confirmation and the same request as the detail
 * view. What matters here is that a row menu is not a shortcut past either: an
 * operation still has to be confirmed, and the row still shows what discovery
 * reported rather than what was asked for.
 */
describe('container quick actions', () => {
  const data = {
    hosts: [host()],
    containers: [container({ state: 'running' })],
  };

  const render = async (api: DockplaneApi) => {
    TestBed.resetTestingModule();

    return renderView(ContainerList, {
      data,
      permissions: ['containers.read', 'containers.restart'],
      providers: [{ provide: DockplaneApi, useValue: api }],
    });
  };

  const openMenu = (fixture: ComponentFixture<ContainerList>) => {
    element(fixture).querySelector<HTMLButtonElement>('dp-row-menu .trigger')?.click();
    fixture.detectChanges();

    return Array.from(element(fixture).querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  };

  const confirm = (fixture: ComponentFixture<ContainerList>) => {
    element(fixture).querySelectorAll<HTMLButtonElement>('dialog footer button')[1].click();
    fixture.detectChanges();
  };

  it('confirms before it dispatches', async () => {
    const api = new TestApi(data);
    const fixture = await render(api);

    openMenu(fixture)
      .find((item) => item.textContent?.includes('Restart'))
      ?.click();
    fixture.detectChanges();

    expect(api.calls).not.toContain('restart:container-1');
    expect(textOf(fixture)).toContain('briefly unavailable');

    confirm(fixture);

    expect(api.calls.filter((call) => call === 'restart:container-1')).toHaveLength(1);
  });

  it('reads the list again once the operation returns', async () => {
    const api = new TestApi(data);
    const fixture = await render(api);

    const before = api.calls.filter((call) => call.startsWith('containers:')).length;

    openMenu(fixture)
      .find((item) => item.textContent?.includes('Restart'))
      ?.click();
    fixture.detectChanges();
    confirm(fixture);
    await fixture.whenStable();
    fixture.detectChanges();

    const after = api.calls.filter((call) => call.startsWith('containers:')).length;

    expect(after).toBeGreaterThan(before);
  });

  it('reports a refusal without changing the row', async () => {
    const api = new TestApi(data);

    api.runContainerOperation = () =>
      throwError(
        () =>
          new HttpErrorResponse({
            status: 409,
            error: { code: 'AGENT_OFFLINE', message: 'agent agent-1 is not connected' },
          }),
      );

    const fixture = await render(api);

    openMenu(fixture)
      .find((item) => item.textContent?.includes('Restart'))
      ?.click();
    fixture.detectChanges();
    confirm(fixture);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(textOf(fixture)).toContain('AGENT_OFFLINE');
    expect(textOf(fixture)).toContain('not connected, so the operation was not carried out');
    expect(textOf(fixture)).not.toContain('agent agent-1');
    expect(element(fixture).querySelector('tbody')?.textContent).toContain('Running');
  });
});
