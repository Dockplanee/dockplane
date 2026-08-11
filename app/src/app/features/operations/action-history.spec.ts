import { ActionRecord } from '../../data/dockplane-api';
import { element, renderView, textOf } from '../../../testing/harness';
import { ActionHistory } from './action-history';

const RECORDS: readonly ActionRecord[] = [
  {
    id: 'action-1',
    capability: 'container.restart',
    status: 'succeeded',
    requestedAt: '2026-08-09T12:00:00.000Z',
    completedAt: '2026-08-09T12:00:02.400Z',
    durationMs: 2400,
    containerName: 'shop-web-1',
    hostname: 'docker-01',
    actor: 'ops@example.internal',
  },
  {
    id: 'action-2',
    capability: 'container.stop',
    status: 'timed_out',
    requestedAt: '2026-08-09T11:00:00.000Z',
    containerName: 'shop-db-1',
    hostname: 'docker-01',
    actor: 'ops@example.internal',
    errorCode: 'AGENT_REQUEST_TIMEOUT',
  },
];

/**
 * The action history.
 *
 * It answers what happened on a host: which operation, against which container,
 * how long it took and how it ended. A timed-out action is shown as its own
 * result rather than folded into failure, because the two mean different things
 * to whoever has to decide what to do next.
 */
describe('action history', () => {
  it('shows what was asked for and what came of it', async () => {
    const fixture = await renderView(ActionHistory, {
      data: { actionRecords: RECORDS },
      permissions: ['containers.read'],
    });

    expect(textOf(fixture)).toContain('Restart');
    expect(textOf(fixture)).toContain('shop-web-1');
    expect(textOf(fixture)).toContain('ops@example.internal');
    expect(textOf(fixture)).toContain('Succeeded');
    expect(textOf(fixture)).toContain('2.4s');
  });

  it('separates a timed-out action from a failed one', async () => {
    const fixture = await renderView(ActionHistory, {
      data: { actionRecords: RECORDS },
      permissions: ['containers.read'],
    });

    const rows = element(fixture).querySelector('tbody')?.textContent ?? '';

    expect(rows).toContain('Timed out');
    expect(rows).toContain('AGENT_REQUEST_TIMEOUT');
    expect(rows).not.toContain('Failed');
  });

  it('says so plainly when nothing has been carried out', async () => {
    const fixture = await renderView(ActionHistory, {
      data: { actionRecords: [] },
      permissions: ['containers.read'],
    });

    expect(textOf(fixture)).toContain('No actions recorded');
  });
});
