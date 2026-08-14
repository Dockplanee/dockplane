import { host } from '../../../testing/data';
import { renderView, textOf } from '../../../testing/harness';
import { HostOverviewTab } from './host-overview-tab';
import { HostStore } from './host-store';

/**
 * What a host's overview shows, and when it says the values are old.
 *
 * Inventory is kept after a host stops reporting so that somebody can still
 * see what it was doing — which is the moment they most want to know. So the
 * readings stay on the page, and the page says they are the last ones rather
 * than showing them as a live gauge.
 */
describe('the host overview', () => {
  const render = (overrides: Parameters<typeof host>[0]) =>
    renderView(HostOverviewTab, {
      params: { id: 'host-1' },
      data: { hosts: [host({ id: 'host-1', ...overrides })] },
      permissions: ['hosts.read'] as never,
      providers: [HostStore],
    });

  /*
   * CPU is reported as a percentage and nothing else. The panel used to
   * require an absolute figure beside every reading, so it dropped CPU on
   * every host and stood empty on a host that reports only that.
   */
  it('shows a reading that has no absolute figure beside it', async () => {
    const fixture = await render({ cpu: { percent: 3 }, memory: undefined, disk: undefined });

    expect(textOf(fixture)).toContain('CPU');
    expect(textOf(fixture)).toContain('3%');
  });

  it('keeps the readings of a host that has stopped reporting', async () => {
    const fixture = await render({
      stale: true,
      agentStatus: 'disconnected',
      status: 'offline',
      cpu: { percent: 4 },
    });

    const shown = textOf(fixture);

    expect(shown).toContain('4%');
    expect(shown).toContain('Last known');
  });

  it('says nothing is known when a host has never reported one', async () => {
    const fixture = await render({ cpu: undefined, memory: undefined, disk: undefined });

    expect(textOf(fixture)).toContain('never reported');
  });

  /* A host that is answering shows its readings as readings. */
  it('does not mark a reporting host’s values as the last known', async () => {
    const fixture = await render({ stale: false, agentStatus: 'connected', cpu: { percent: 7 } });

    expect(textOf(fixture)).toContain('7%');
    expect(textOf(fixture)).not.toContain('Last known');
  });
});
