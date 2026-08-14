import { host } from '../../../testing/data';
import { renderView, textOf } from '../../../testing/harness';
import { ContainerCreate } from './container-create';

/**
 * Which host a container may be created on.
 *
 * Creating one changes a host straight away — there is no saved configuration
 * waiting to be applied later — so it needs a host that is answering now. The
 * control server refuses anything else, and the form has to say why before an
 * operator has filled it in.
 *
 * A machine enrolled more than once leaves a host resource behind for every
 * enrolment, all reporting the same system hostname. Hiding the ones that
 * cannot be used would leave an operator looking for a host they can see in the
 * host list and cannot find here.
 */
describe('choosing a host for a new container', () => {
  const render = (hosts: Parameters<typeof host>[0][]) =>
    renderView(ContainerCreate, {
      data: { hosts: hosts.map((overrides) => host(overrides)) },
      permissions: ['containers.read', 'containers.create'] as never,
    });

  const options = (fixture: { nativeElement: unknown }) =>
    [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('select[name="hostId"] option'),
    ].map((option) => ({
      value: (option as HTMLOptionElement).value,
      label: option.textContent?.trim() ?? '',
      disabled: (option as HTMLOptionElement).disabled,
    }));

  it('offers a host whose agent is connected', async () => {
    const fixture = await render([{ id: 'host-live', name: 'stable-smoke' }]);
    const live = options(fixture).find((option) => option.value === 'host-live');

    expect(live?.disabled).toBe(false);
  });

  it('shows a host whose agent is offline, and does not let it be chosen', async () => {
    const fixture = await render([
      { id: 'host-live', name: 'stable-smoke' },
      { id: 'host-gone', name: 'rc4-smoke', agentStatus: 'disconnected', status: 'offline' },
    ]);

    const offline = options(fixture).find((option) => option.value === 'host-gone');

    expect(offline).toBeDefined();
    expect(offline?.disabled).toBe(true);
    expect(offline?.label).toContain('rc4-smoke');
  });

  it('does not let a revoked host be chosen either', async () => {
    const fixture = await render([
      { id: 'host-live', name: 'stable-smoke' },
      { id: 'host-revoked', name: 'docker-test', agentStatus: 'revoked', status: 'offline' },
    ]);

    expect(options(fixture).find((option) => option.value === 'host-revoked')?.disabled).toBe(true);
  });

  it('explains why a host in the list cannot be chosen', async () => {
    const fixture = await render([
      { id: 'host-live', name: 'stable-smoke' },
      { id: 'host-gone', name: 'rc4-smoke', agentStatus: 'disconnected', status: 'offline' },
    ]);

    expect(textOf(fixture)).toContain('offline cannot be chosen');
  });

  /*
   * An empty select and a select whose every option is disabled look the same
   * to somebody who has just opened the page.
   */
  it('says so when nothing can be created on anything', async () => {
    const fixture = await render([
      { id: 'host-gone', name: 'rc4-smoke', agentStatus: 'disconnected', status: 'offline' },
    ]);

    expect(textOf(fixture)).toContain('No connected hosts are currently available');
  });

  it('says nothing about offline hosts when every host is connected', async () => {
    const fixture = await render([{ id: 'host-live', name: 'stable-smoke' }]);
    const shown = textOf(fixture);

    expect(shown).not.toContain('No connected hosts');
    expect(shown).not.toContain('offline cannot be chosen');
  });
});
