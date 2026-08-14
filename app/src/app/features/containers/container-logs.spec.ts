import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';

import { DockplaneApi, LogLine } from '../../data/dockplane-api';
import { container, host } from '../../../testing/data';
import { checkAccessibility } from '../../../testing/accessibility';
import { element, headingLevels, renderView, textOf } from '../../../testing/harness';
import { TestApi } from '../../../testing/test-api';
import { ContainerLogsTab } from './container-logs-tab';
import { ContainerStore } from './container-store';

const SECRET = 'PASSWORD=THIS-MUST-NOT-BE-LOGGED-TO-THE-CONSOLE';

function line(message: string, stream: 'stdout' | 'stderr' = 'stdout'): LogLine {
  return { stream, message, timestamp: '2026-08-10T12:00:00.000Z' };
}

/**
 * The log viewer.
 *
 * It shows what a container printed and offers no way to send anything back.
 * The rest is about honesty under pressure: a stream that ends says so, output
 * that could not be delivered is admitted, and a view that drops old lines
 * tells the reader rather than quietly forgetting.
 */
describe('container logs', () => {
  let api: TestApi;

  const render = async (
    permissions: string[],
    data = { hosts: [host()], containers: [container()] },
  ) => {
    TestBed.resetTestingModule();
    api = new TestApi(data);

    return renderView(ContainerLogsTab, {
      params: { id: 'container-1' },
      permissions: permissions as never,
      providers: [{ provide: DockplaneApi, useValue: api }, ContainerStore],
    });
  };

  const deliver = async (fixture: { detectChanges(): void }, lines: LogLine[]) => {
    api.logEvents.next({ kind: 'lines', lines });
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
  };

  const open = async (fixture: { detectChanges(): void }) => {
    api.logEvents.next({ kind: 'open', streamId: 'stream-1' });
    fixture.detectChanges();
  };

  const button = (fixture: { nativeElement: unknown }, label: string) =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.includes(label),
    ) as HTMLButtonElement | undefined;

  it('offers nothing to an operator without the permission', async () => {
    const fixture = await render(['containers.read']);

    expect(textOf(fixture)).toContain('containers.logs permission');
    expect(api.calls.filter((call) => call.startsWith('streamContainerLogs'))).toHaveLength(0);
  });

  it('opens a stream for an operator who holds the permission', async () => {
    await render(['containers.read', 'containers.logs']);

    expect(api.calls.some((call) => call.startsWith('streamContainerLogs:container-1'))).toBe(true);
  });

  it('shows the lines the host sent, keeping stdout and stderr apart', async () => {
    const fixture = await render(['containers.read', 'containers.logs']);

    await open(fixture);
    await deliver(fixture, [line('listening on 8080'), line('database unreachable', 'stderr')]);

    expect(textOf(fixture)).toContain('listening on 8080');
    expect(textOf(fixture)).toContain('database unreachable');

    const stderr = element(fixture).querySelectorAll('.line--stderr');

    expect(stderr).toHaveLength(1);
    expect(stderr[0].textContent).toContain('database unreachable');
  });

  /**
   * A log viewer is not a console.
   *
   * Nothing on this page accepts text. The property is asserted rather than
   * assumed, because a text field would be an easy thing to add and an
   * impossible thing to notice in review.
   */
  it('has no way to send anything to the container', async () => {
    const fixture = await render(['containers.read', 'containers.logs']);

    await open(fixture);
    await deliver(fixture, [line('ready')]);

    const inputs = Array.from(element(fixture).querySelectorAll('input, textarea'));
    const writable = inputs.filter((field) => field.getAttribute('type') !== 'search');

    expect(writable).toHaveLength(0);
    expect(element(fixture).querySelector('form')).toBeNull();
  });

  it('filters what is shown without asking the server again', async () => {
    const fixture = await render(['containers.read', 'containers.logs']);

    await open(fixture);
    await deliver(fixture, [line('first message'), line('second message'), line('third')]);

    const before = api.calls.length;
    const search = element(fixture).querySelector('input[type="search"]') as HTMLInputElement;

    search.value = 'second';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(textOf(fixture)).toContain('second message');
    expect(textOf(fixture)).not.toContain('first message');
    // Search reads what is already here; there is no server-side log index.
    expect(api.calls.length).toBe(before);
  });

  /**
   * Pausing holds the view, not the stream.
   *
   * The stream keeps running so resuming does not lose the moment that was
   * worth pausing for, and what is held is bounded so a pause left running does
   * not become the browser's memory problem.
   */
  it('holds new lines while paused and shows them on resume', async () => {
    const fixture = await render(['containers.read', 'containers.logs']);

    await open(fixture);
    await deliver(fixture, [line('before pause')]);

    button(fixture, 'Pause')?.click();
    fixture.detectChanges();

    await deliver(fixture, [line('while paused')]);

    expect(textOf(fixture)).toContain('before pause');
    expect(textOf(fixture)).not.toContain('while paused');

    button(fixture, 'Resume')?.click();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    expect(textOf(fixture)).toContain('while paused');
  });

  it('says so when the host could not deliver everything', async () => {
    const fixture = await render(['containers.read', 'containers.logs']);

    await open(fixture);
    api.logEvents.next({ kind: 'dropped', count: 42, where: 'agent' });
    fixture.detectChanges();

    expect(textOf(fixture)).toContain('42 lines were not delivered');
    expect(textOf(fixture)).toContain('incomplete');
  });

  it('reports a stream the server ended, with the reason', async () => {
    const fixture = await render(['containers.read', 'containers.logs']);

    await open(fixture);
    api.logEvents.next({ kind: 'end', reason: 'agent_disconnected', code: 'AGENT_OFFLINE' });
    fixture.detectChanges();

    expect(textOf(fixture)).toContain('AGENT_OFFLINE');
    // The code alone is not an explanation; the operator gets words too.
    expect(textOf(fixture)).toContain('Live logs are unavailable while the host is offline');
    expect(textOf(fixture)).toContain('Disconnected');
    expect(button(fixture, 'Reconnect')).toBeDefined();
  });

  /**
   * A container whose host has stopped answering.
   *
   * The resource is still there and its page still opens, so the log view has
   * to say that the stream is what is missing. Saying the container was not
   * found — or repeating wording about an operation that was not carried out —
   * would send somebody looking for a workload that never went anywhere.
   */
  describe('when the host is offline', () => {
    it('says the live stream is what is unavailable', async () => {
      const fixture = await render(['containers.read', 'containers.logs']);

      await open(fixture);
      api.logEvents.error(
        new HttpErrorResponse({
          status: 409,
          error: { code: 'AGENT_OFFLINE', message: 'The agent is not connected.' },
        }),
      );
      fixture.detectChanges();

      const shown = textOf(fixture);

      expect(shown).toContain('Live logs are unavailable while the host is offline');
      expect(shown).not.toContain('not found');
      expect(shown).not.toContain('does not exist');
    });

    it('does not claim an operation was attempted', async () => {
      const fixture = await render(['containers.read', 'containers.logs']);

      await open(fixture);
      api.logEvents.next({ kind: 'end', reason: 'agent_disconnected', code: 'AGENT_OFFLINE' });
      fixture.detectChanges();

      expect(textOf(fixture)).not.toContain('was not carried out');
    });

    /* A revoked credential is a different thing from a host that went quiet. */
    it('distinguishes a revoked agent from an offline one', async () => {
      const fixture = await render(['containers.read', 'containers.logs']);

      await open(fixture);
      api.logEvents.next({ kind: 'end', reason: 'revoked', code: 'AGENT_REVOKED' });
      fixture.detectChanges();

      expect(textOf(fixture)).toContain('no agent credential that may be reached');
    });
  });

  it('reconnects on request', async () => {
    const fixture = await render(['containers.read', 'containers.logs']);

    await open(fixture);
    api.logEvents.next({ kind: 'end', reason: 'timeout', code: 'LOG_STREAM_TIMEOUT' });
    fixture.detectChanges();

    const before = api.calls.filter((call) => call.startsWith('streamContainerLogs')).length;

    button(fixture, 'Reconnect')?.click();
    fixture.detectChanges();

    const after = api.calls.filter((call) => call.startsWith('streamContainerLogs')).length;

    expect(after).toBe(before + 1);
  });

  /**
   * A view that is destroyed leaves no stream behind.
   *
   * The stream costs a Docker reader on a managed host, so a viewer that
   * navigates away has to release it. Nothing else tells the server.
   */
  it('closes the stream when the view goes away', async () => {
    const fixture = await render(['containers.read', 'containers.logs']);

    await open(fixture);

    expect(api.openStreams).toBe(1);

    fixture.destroy();

    expect(api.openStreams).toBe(0);
  });

  it('clears only what is on screen', async () => {
    const fixture = await render(['containers.read', 'containers.logs']);

    await open(fixture);
    await deliver(fixture, [line('printed once')]);

    const before = api.calls.length;

    button(fixture, 'Clear view')?.click();
    fixture.detectChanges();

    expect(textOf(fixture)).not.toContain('printed once');
    // Nothing is stored, so clearing asks the server for nothing.
    expect(api.calls.length).toBe(before);
  });

  /**
   * Log content stays in the page.
   *
   * A container may print anything, including credentials. The viewer must not
   * copy it into the browser console, where it outlives the view and is picked
   * up by whatever collects console output.
   */
  it('writes no log content to the browser console', async () => {
    const written: string[] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const originals = methods.map((method) => console[method]);

    methods.forEach((method) => {
      console[method] = (...args: unknown[]) => written.push(args.map(String).join(' '));
    });

    try {
      const fixture = await render(['containers.read', 'containers.logs']);

      await open(fixture);
      await deliver(fixture, [line(SECRET), line(SECRET, 'stderr')]);

      expect(written.join('\n')).not.toContain(SECRET);
    } finally {
      methods.forEach((method, index) => {
        console[method] = originals[index];
      });
    }
  });

  it('has no accessibility violations', async () => {
    const fixture = await render(['containers.read', 'containers.logs']);

    await open(fixture);
    await deliver(fixture, [line('listening on 8080'), line('failed', 'stderr')]);

    const { violations } = await checkAccessibility(fixture);

    expect(violations.join('\n\n')).toBe('');

    const levels = headingLevels(fixture);

    for (let index = 1; index < levels.length; index += 1) {
      expect(levels[index] - levels[index - 1]).toBeLessThanOrEqual(1);
    }
  });

  /**
   * The stream is told apart by more than colour.
   *
   * stderr is red, and it also says so: an operator who cannot distinguish the
   * two colours still has to be able to tell an error line from an ordinary
   * one.
   */
  it('marks stderr with something other than colour', async () => {
    const fixture = await render(['containers.read', 'containers.logs']);

    await open(fixture);
    await deliver(fixture, [line('failed to bind', 'stderr')]);

    const row = element(fixture).querySelector('.line--stderr');

    expect(row?.textContent).toContain('err');
    expect(row?.textContent).toContain('stderr');
  });

  it('marks a line the agent had to cut', async () => {
    const fixture = await render(['containers.read', 'containers.logs']);

    await open(fixture);
    await deliver(fixture, [{ ...line('a very long line'), truncated: true }]);

    expect(element(fixture).querySelector('.line__mark')).not.toBeNull();
  });

  it('says the host is not reporting rather than showing a live indicator', async () => {
    const fixture = await render(['containers.read', 'containers.logs'], {
      hosts: [host({ status: 'offline', agentStatus: 'disconnected' })],
      containers: [container({ stale: true })],
    });

    expect(textOf(fixture)).toContain('not reporting');
    expect(textOf(fixture)).toContain('Disconnected');
  });
});
