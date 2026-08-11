import { container, host, project } from '../../../testing/data';
import { TestData } from '../../../testing/test-api';
import { renderView, textOf } from '../../../testing/harness';
import { Overview } from './overview';

const PERMISSIONS = ['hosts.read', 'containers.read', 'compose.read'] as const;

function hostRow(element: HTMLElement, name: string): HTMLTableRowElement | undefined {
  const table = element.querySelector('table[aria-labelledby="hosts-heading"]');

  return Array.from(table?.querySelectorAll('tbody tr') ?? []).find((row) =>
    row.querySelector('th')?.textContent?.includes(name),
  ) as HTMLTableRowElement | undefined;
}

const render = (data: TestData) => renderView(Overview, { data, permissions: [...PERMISSIONS] });

describe('Overview', () => {
  it('counts what the control server returned', async () => {
    const fixture = await render({
      hosts: [host(), host({ id: 'host-2', name: 'docker-02' })],
      containers: [container(), container({ id: 'container-2', state: 'stopped' })],
      composeProjects: [project()],
    });

    const cards = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('dp-summary-card'),
    ).map((card) => card.textContent ?? '');

    expect(cards).toHaveLength(4);
    expect(cards[0]).toContain('2');
    expect(cards[1]).toContain('2');
    expect(cards[1]).toContain('1 running');
    expect(cards[2]).toContain('1');
  });

  /**
   * The control server keeps current state, not history. A trend line or a
   * percentage change would be decoration standing in for data that does not
   * exist, so the cards carry neither.
   */
  it('shows no trend or change figure', async () => {
    const fixture = await render({ hosts: [host()], containers: [], composeProjects: [] });
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('dp-sparkline')).toBeNull();
    expect(textOf(fixture)).not.toMatch(/[+-]\d+%/);
  });

  it('reports an offline host as needing attention', async () => {
    const fixture = await render({
      hosts: [host({ status: 'offline', stale: true, agentStatus: 'disconnected' })],
      containers: [],
      composeProjects: [],
    });

    expect(textOf(fixture)).toContain('docker-01 is offline');
  });

  it('reports a stale host without calling it offline', async () => {
    const fixture = await render({
      hosts: [host({ status: 'unknown', stale: true })],
      containers: [],
      composeProjects: [],
    });

    const text = textOf(fixture);

    expect(text).toContain('has not reported recently');
    expect(text).not.toContain('is offline');
  });

  it('reports an unhealthy container and a degraded project', async () => {
    const fixture = await render({
      hosts: [host()],
      containers: [container({ health: 'unhealthy' })],
      composeProjects: [project({ state: 'degraded', servicesRunning: 1 })],
    });

    const text = textOf(fixture);

    expect(text).toContain('shop-web-1 is unhealthy');
    expect(text).toContain('shop is degraded');
  });

  it('says nothing needs attention when nothing does', async () => {
    const fixture = await render({
      hosts: [host()],
      containers: [container()],
      composeProjects: [project()],
    });

    expect(textOf(fixture)).toContain('Nothing needs attention');
  });

  /**
   * There is no operations endpoint, so there is no action history. A panel of
   * invented rows would read as a record of things Dockplane had done.
   */
  it('does not offer a recent actions panel', async () => {
    const fixture = await render({ hosts: [host()], containers: [], composeProjects: [] });

    expect(textOf(fixture)).not.toContain('Recent actions');
  });

  it('counts a host’s containers from the containers it returned', async () => {
    const fixture = await render({
      hosts: [host()],
      containers: [container(), container({ id: 'container-2', state: 'stopped' })],
      composeProjects: [],
    });

    const row = hostRow(fixture.nativeElement as HTMLElement, 'docker-01');

    expect(row?.textContent).toContain('1 / 2');
  });

  it('marks a stale host in its row and keeps its last known metrics', async () => {
    const fixture = await render({
      hosts: [host({ stale: true, status: 'unknown' })],
      containers: [],
      composeProjects: [],
    });

    const row = hostRow(fixture.nativeElement as HTMLElement, 'docker-01');

    expect(row?.textContent).toContain('Last observed');
    // The reading is history, not a current value, but deleting it would leave
    // an operator with nothing at the moment they most need the last state.
    expect(row?.querySelectorAll('dp-meter').length).toBe(3);
  });

  it('shows no metric where the host reported none', async () => {
    const fixture = await render({
      hosts: [host({ cpu: undefined, memory: undefined, disk: undefined })],
      containers: [],
      composeProjects: [],
    });

    const row = hostRow(fixture.nativeElement as HTMLElement, 'docker-01');

    expect(row?.querySelectorAll('dp-meter').length).toBe(0);
    expect(row?.textContent).toContain('—');
  });

  it('does not render a full container table', async () => {
    const fixture = await render({
      hosts: [host()],
      containers: [container()],
      composeProjects: [],
    });

    expect(textOf(fixture)).not.toContain('nginx:1.27');
  });
});
