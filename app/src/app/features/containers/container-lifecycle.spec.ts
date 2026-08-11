import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Observable, Subject, throwError } from 'rxjs';

import { ActionOutcome, ContainerOperation, DockplaneApi } from '../../data/dockplane-api';
import { container, host } from '../../../testing/data';
import { element, renderView, textOf } from '../../../testing/harness';
import { TestApi, TestData } from '../../../testing/test-api';
import { ContainerDetail } from './container-detail';

/** An operation whose answer the test decides, so an in-flight state is real. */
class PendingApi extends TestApi {
  readonly outcome = new Subject<ActionOutcome>();

  override runContainerOperation(
    operation: ContainerOperation,
    containerId: string,
  ): Observable<ActionOutcome> {
    this.calls.push(`${operation}:${containerId}`);

    return this.outcome.asObservable();
  }
}

/**
 * Container lifecycle in the interface.
 *
 * The rule the whole view follows: a control is offered only where it can
 * succeed, an operation is confirmed before it runs, and nothing on screen
 * changes until the control server says what the host reported afterwards.
 */
describe('container lifecycle', () => {
  const render = async (data: TestData, permissions: readonly string[], api?: DockplaneApi) => {
    TestBed.resetTestingModule();

    return renderView(ContainerDetail, {
      params: { id: 'container-1' },
      data,
      permissions: permissions as never,
      providers: api ? [{ provide: DockplaneApi, useValue: api }] : [],
    });
  };

  const running = { hosts: [host()], containers: [container({ state: 'running' })] };
  const stopped = {
    hosts: [host()],
    containers: [container({ state: 'stopped', health: 'none' })],
  };

  const button = (fixture: { nativeElement: unknown }, label: string) =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.actions button')).find(
      (candidate) => candidate.textContent?.includes(label),
    ) as HTMLButtonElement | undefined;

  const confirm = (fixture: { nativeElement: unknown; detectChanges: () => void }) => {
    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
      'dialog footer button',
    );

    buttons[1].click();
    fixture.detectChanges();
  };

  it('offers an operation only to an operator who holds it', async () => {
    const fixture = await render(running, ['containers.read', 'containers.restart']);

    expect(button(fixture, 'Restart')?.disabled).toBe(false);
    expect(button(fixture, 'Stop')?.disabled).toBe(true);
    expect(button(fixture, 'Stop')?.getAttribute('title')).toContain('containers.stop');
  });

  it('offers start only for a container that is not running', async () => {
    const stoppedView = await render(stopped, ['containers.read', 'containers.start']);

    expect(button(stoppedView, 'Start')?.disabled).toBe(false);

    const runningView = await render(running, ['containers.read', 'containers.start']);

    expect(button(runningView, 'Start')?.disabled).toBe(true);
    expect(button(runningView, 'Start')?.getAttribute('title')).toContain('already running');
  });

  /**
   * A host with no connected agent cannot carry anything out.
   *
   * The control server refuses the request, so offering it would produce a
   * refusal the operator could have been spared.
   */
  it('offers nothing while the host is not reachable', async () => {
    const fixture = await render(
      {
        hosts: [host({ status: 'offline', agentStatus: 'disconnected' })],
        containers: [container()],
      },
      ['containers.read', 'containers.restart', 'containers.stop'],
    );

    expect(button(fixture, 'Restart')?.disabled).toBe(true);
    expect(button(fixture, 'Restart')?.getAttribute('title')).toContain('not reachable');
  });

  it('dispatches nothing until the operation is confirmed', async () => {
    const api = new TestApi(running);
    const fixture = await render(running, ['containers.read', 'containers.restart'], api);

    button(fixture, 'Restart')?.click();
    fixture.detectChanges();

    expect(api.calls).not.toContain('restart:container-1');

    confirm(fixture);

    expect(api.calls).toContain('restart:container-1');
  });

  it('sends exactly one request for one confirmation', async () => {
    const api = new TestApi(running);
    const fixture = await render(running, ['containers.read', 'containers.restart'], api);

    button(fixture, 'Restart')?.click();
    fixture.detectChanges();
    confirm(fixture);

    expect(api.calls.filter((call) => call === 'restart:container-1')).toHaveLength(1);
  });

  /**
   * The badge keeps showing what discovery reported.
   *
   * A start that was accepted is not a container that is running. Painting the
   * new state on the strength of the request would tell an operator something
   * the host has not confirmed, and would hide a start that silently failed.
   */
  it('claims no state the host has not confirmed', async () => {
    const api = new TestApi(stopped);
    const fixture = await render(stopped, ['containers.read', 'containers.start'], api);

    button(fixture, 'Start')?.click();
    fixture.detectChanges();
    confirm(fixture);
    await fixture.whenStable();
    fixture.detectChanges();

    // The double keeps answering "stopped", and so does the view.
    expect(element(fixture).querySelector('.identity')?.textContent).toContain('Stopped');
  });

  it('reads the container again once the operation returns', async () => {
    const api = new TestApi({ ...stopped, containerDetail: undefined });
    const fixture = await render(stopped, ['containers.read', 'containers.start'], api);

    const before = api.calls.filter((call) => call.startsWith('containerDetail')).length;

    button(fixture, 'Start')?.click();
    fixture.detectChanges();
    confirm(fixture);
    await fixture.whenStable();
    fixture.detectChanges();

    const after = api.calls.filter((call) => call.startsWith('containerDetail')).length;

    expect(after).toBeGreaterThan(before);
  });

  it('refuses a second request while one is running', async () => {
    const api = new PendingApi(running);
    const fixture = await render(running, ['containers.read', 'containers.restart'], api);

    button(fixture, 'Restart')?.click();
    fixture.detectChanges();
    confirm(fixture);
    fixture.detectChanges();

    // The dialog reports the request as working, and the controls it came from
    // are closed to a second one until the server has answered.
    expect(textOf(fixture)).toContain('Working…');
    expect(button(fixture, 'Restart')?.disabled).toBe(true);

    confirm(fixture);

    expect(api.calls.filter((call) => call === 'restart:container-1')).toHaveLength(1);

    api.outcome.next({ actionId: 'action-1', status: 'succeeded', state: 'running' });
    api.outcome.complete();
    fixture.detectChanges();
  });

  it("reports a refusal in the interface's own words", async () => {
    const api = new TestApi(running);

    api.runContainerOperation = () =>
      throwError(
        () =>
          new HttpErrorResponse({
            status: 409,
            error: {
              code: 'CONTAINER_ALREADY_RUNNING',
              message: 'container aaa111 is already running',
              requestId: 'req-7',
            },
          }),
      );

    const fixture = await render(running, ['containers.read', 'containers.restart'], api);

    button(fixture, 'Restart')?.click();
    fixture.detectChanges();
    confirm(fixture);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(textOf(fixture)).toContain('CONTAINER_ALREADY_RUNNING');
    expect(textOf(fixture)).toContain('already running');
    expect(textOf(fixture)).not.toContain('aaa111 is already running');
  });

  /**
   * A timeout is not a failure.
   *
   * The control server stopped waiting; Docker may well have carried the
   * operation out. Saying so is the only honest answer, and it points the
   * operator at the state that was observed rather than at the request.
   */
  it('says a timed-out operation may still have been carried out', async () => {
    const api = new TestApi({
      ...running,
      actionOutcome: {
        actionId: 'action-9',
        status: 'timed_out',
        errorCode: 'AGENT_REQUEST_TIMEOUT',
      },
    });
    const fixture = await render(running, ['containers.read', 'containers.restart'], api);

    button(fixture, 'Restart')?.click();
    fixture.detectChanges();
    confirm(fixture);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(textOf(fixture)).toContain('may still have been carried out');
    expect(textOf(fixture)).toContain('action-9');
  });

  it('announces the result without leaving the dialog open', async () => {
    const api = new TestApi(running);
    const fixture = await render(running, ['containers.read', 'containers.restart'], api);

    button(fixture, 'Restart')?.click();
    fixture.detectChanges();
    confirm(fixture);
    await fixture.whenStable();
    fixture.detectChanges();

    const status = element(fixture).querySelector('[role="status"]');

    expect(status?.textContent).toContain('restarted');
    expect(element(fixture).querySelector('dialog')?.open).toBeFalsy();
  });

  it('offers no operation to an operator who only reads', async () => {
    const fixture = await render(running, ['containers.read']);

    for (const label of ['Start', 'Stop', 'Restart']) {
      expect(button(fixture, label)?.disabled).toBe(true);
    }
  });
});
