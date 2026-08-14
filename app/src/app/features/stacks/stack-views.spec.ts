import { describe, expect, it } from 'vitest';

import { checkAccessibility } from '../../../testing/accessibility';
import { renderView, textOf } from '../../../testing/harness';
import { Stack } from '../../domain/stacks';
import { StackDetail } from './stack-detail';
import { StackList } from './stack-list';

/**
 * What the stack views offer, and what they do not.
 *
 * The permission checks are the point. The control server authorises every
 * request independently, so a hidden button is never the boundary — but an
 * interface that offers an action nobody may take is one that produces refusals
 * an operator cannot explain.
 */
const stack = (overrides: Partial<Stack> = {}): Stack => ({
  id: 'stack-1',
  name: 'shop',
  hostId: 'host-1',
  hostName: 'docker-01',
  hostname: 'docker-01',
  sourceType: 'dockplane',
  status: 'running',
  latestRevision: {
    id: 'revision-2',
    number: 2,
    summary: { services: ['web'], networks: [], volumes: [] },
  },
  deployedRevision: {
    id: 'revision-2',
    number: 2,
    summary: { services: ['web'], networks: [], volumes: [] },
  },
  reconciling: false,
  hostReachable: true,
  updatedAt: '2026-08-13T10:00:00.000Z',
  ...overrides,
});

describe('the stack list', () => {
  it('offers creating a stack to somebody who may', async () => {
    const fixture = await renderView(StackList, {
      data: { stacks: [stack()] },
      permissions: ['stacks.read', 'stacks.create'],
    });

    expect(textOf(fixture)).toContain('Create stack');
  });

  it('does not offer it to somebody who may not', async () => {
    const fixture = await renderView(StackList, {
      data: { stacks: [stack()] },
      permissions: ['stacks.read'],
    });

    expect(textOf(fixture)).not.toContain('Create stack');
  });

  /*
   * Saving a change without deploying it is an ordinary state. It says so in
   * its own words rather than looking like a fault.
   */
  it('says when what is saved is not what is running', async () => {
    const fixture = await renderView(StackList, {
      data: {
        stacks: [
          stack({
            latestRevision: { id: 'revision-3', number: 3 },
            deployedRevision: { id: 'revision-2', number: 2 },
          }),
        ],
      },
      permissions: ['stacks.read'],
    });

    expect(textOf(fixture)).toContain('Changes not deployed');
  });

  it('says when a stack has never been deployed', async () => {
    const fixture = await renderView(StackList, {
      data: { stacks: [stack({ deployedRevision: null, status: 'not_deployed' })] },
      permissions: ['stacks.read'],
    });

    expect(textOf(fixture)).toContain('Not deployed');
  });

  /* Needing attention outranks every other thing a stack could be. */
  it('shows a stack that needs attention as needing attention', async () => {
    const fixture = await renderView(StackList, {
      data: {
        stacks: [
          stack({
            status: 'needs_attention',
            latestRevision: { id: 'revision-3', number: 3 },
            deployedRevision: { id: 'revision-2', number: 2 },
          }),
        ],
      },
      permissions: ['stacks.read'],
    });

    expect(textOf(fixture)).toContain('Needs attention');
    expect(textOf(fixture)).not.toContain('Changes not deployed');
  });

  it('has no accessibility violations', async () => {
    const fixture = await renderView(StackList, {
      data: { stacks: [stack()] },
      permissions: ['stacks.read', 'stacks.create'],
    });

    const { violations } = await checkAccessibility(fixture);

    expect(violations.join('\n\n')).toBe('');
  });
});

describe('one stack', () => {
  const render = (overrides: Partial<Stack>, permissions: string[]) =>
    renderView(StackDetail, {
      params: { id: 'stack-1' },
      data: { stacks: [stack(overrides)] },
      permissions: permissions as never,
    });

  it('offers editing and deploying to somebody who may', async () => {
    const fixture = await render(
      {
        latestRevision: { id: 'revision-3', number: 3 },
        deployedRevision: { id: 'revision-2', number: 2 },
      },
      ['stacks.read', 'stacks.update', 'stacks.deploy'],
    );

    expect(textOf(fixture)).toContain('Edit configuration');
    expect(textOf(fixture)).toContain('Deploy revision #3');
  });

  it('offers neither to somebody who may only look', async () => {
    const fixture = await render(
      {
        latestRevision: { id: 'revision-3', number: 3 },
        deployedRevision: { id: 'revision-2', number: 2 },
      },
      ['stacks.read'],
    );

    expect(textOf(fixture)).not.toContain('Edit configuration');
  });

  /*
   * Applying the revision that is already running would recreate every
   * container to arrive back where it started.
   */
  it('offers nothing to apply when the newest revision is the running one', async () => {
    const fixture = await render({}, ['stacks.read', 'stacks.deploy']);

    expect(textOf(fixture)).not.toContain('Deploy revision');
  });

  it('calls going back to an older revision a rollback', async () => {
    const fixture = await render(
      {
        latestRevision: { id: 'revision-1', number: 1 },
        deployedRevision: { id: 'revision-2', number: 2 },
      },
      ['stacks.read', 'stacks.deploy'],
    );

    expect(textOf(fixture)).toContain('Roll back to revision #1');
  });

  it('explains a stack that needs attention', async () => {
    const fixture = await render({ status: 'needs_attention' }, ['stacks.read', 'stacks.deploy']);

    expect(textOf(fixture)).toContain('needs attention');
    expect(textOf(fixture)).toContain('Nothing has been removed');
  });

  it('says a stack is being reconciled rather than that something failed', async () => {
    const fixture = await render({ reconciling: true }, ['stacks.read', 'stacks.deploy']);

    expect(textOf(fixture)).toContain('Reconciling');
    expect(textOf(fixture)).not.toContain('failed');
  });

  it('has no accessibility violations', async () => {
    const fixture = await render({}, ['stacks.read', 'stacks.update', 'stacks.deploy']);
    const { violations } = await checkAccessibility(fixture);

    expect(violations.join('\n\n')).toBe('');
  });
});

/**
 * Which of start, stop and restart a stack is offered.
 *
 * The states matter more than the buttons. A stack that needs attention or is
 * being reconciled is one where nobody yet knows what the host is, and offering
 * to stop half of it is how somebody ends up deciding a repair from evidence
 * that changed underneath them.
 */
describe('operating one stack', () => {
  const render = (overrides: Partial<Stack>, permissions: string[] = ['stacks.read', 'stacks.deploy']) =>
    renderView(StackDetail, {
      params: { id: 'stack-1' },
      data: { stacks: [stack(overrides)] },
      permissions: permissions as never,
    });

  it('offers stopping and restarting a running stack', async () => {
    const fixture = await render({});

    expect(textOf(fixture)).toContain('Stop stack');
    expect(textOf(fixture)).toContain('Restart stack');
    expect(textOf(fixture)).not.toContain('Start stack');
  });

  it('offers starting a stopped one', async () => {
    const fixture = await render({ status: 'stopped' });

    expect(textOf(fixture)).toContain('Start stack');
    expect(textOf(fixture)).not.toContain('Stop stack');
  });

  /*
   * A stopped stack is still deployed. The word has to carry that, or an
   * operator reads "not running" as "not deployed" and deploys it again.
   */
  it('says a stopped stack is still deployed with its revision', async () => {
    const fixture = await render({ status: 'stopped' });

    expect(textOf(fixture)).toContain('Stopped');
    expect(textOf(fixture)).toContain('still deployed with revision #2');
  });

  it('offers nothing to a stack that needs attention', async () => {
    const fixture = await render({ status: 'needs_attention' });

    expect(textOf(fixture)).not.toContain('Stop stack');
    expect(textOf(fixture)).not.toContain('Restart stack');
    expect(textOf(fixture)).not.toContain('Start stack');
  });

  it('offers nothing while the stack is being reconciled', async () => {
    const fixture = await render({ reconciling: true });

    expect(textOf(fixture)).not.toContain('Stop stack');
    expect(textOf(fixture)).not.toContain('Restart stack');
  });

  it('offers nothing to a stack that has never been deployed', async () => {
    const fixture = await render({ deployedRevision: null, status: 'not_deployed' });

    expect(textOf(fixture)).not.toContain('Start stack');
  });

  it('offers nothing to somebody who may only look', async () => {
    const fixture = await render({}, ['stacks.read']);

    expect(textOf(fixture)).not.toContain('Stop stack');
  });

  /* A stack with changes saved is still a running stack that may be stopped. */
  it('offers stopping a stack that has changes saved', async () => {
    const fixture = await render({
      latestRevision: { id: 'revision-3', number: 3 },
      deployedRevision: { id: 'revision-2', number: 2 },
    });

    expect(textOf(fixture)).toContain('Stop stack');
  });

  it('has no accessibility violations when stopped', async () => {
    const fixture = await render({ status: 'stopped' });
    const { violations } = await checkAccessibility(fixture);

    expect(violations.join('\n\n')).toBe('');
  });
});

/**
 * Deleting a stack, as the interface offers it.
 *
 * The states where it is not offered are the point. A stack whose host does not
 * say clearly which containers are its own is one where a destructive action
 * must not be a click away, and the dialog's job is to say what survives —
 * because "delete" reads as "delete everything" to anybody who has run
 * `docker compose down -v`.
 */
describe('deleting one stack', () => {
  const render = (
    overrides: Partial<Stack>,
    permissions: string[] = ['stacks.read', 'stacks.delete'],
  ) =>
    renderView(StackDetail, {
      params: { id: 'stack-1' },
      data: { stacks: [stack(overrides)] },
      permissions: permissions as never,
    });

  it('offers deleting to somebody who may', async () => {
    const fixture = await render({});

    expect(textOf(fixture)).toContain('Delete stack');
  });

  it('does not offer it to somebody who may not', async () => {
    const fixture = await render({}, ['stacks.read', 'stacks.deploy']);

    expect(textOf(fixture)).not.toContain('Delete stack');
  });

  it('does not offer it while the stack needs attention', async () => {
    const fixture = await render({ status: 'needs_attention' });

    expect(textOf(fixture)).not.toContain('Delete stack');
  });

  it('does not offer it while the stack is being reconciled', async () => {
    const fixture = await render({ reconciling: true });

    expect(textOf(fixture)).not.toContain('Delete stack');
  });

  it('offers it for a stack that has never been deployed', async () => {
    const fixture = await render({ deployedRevision: null, status: 'not_deployed' });

    expect(textOf(fixture)).toContain('Delete stack');
  });

  /* The sentence an operator needs before they can decide anything. */
  it('says the volumes are kept and their data is not deleted', async () => {
    const fixture = await render({});

    expect(textOf(fixture)).toContain('Named volumes are kept');
    expect(textOf(fixture)).toContain('no data in them is deleted');
  });

  it('names the volumes it keeps', async () => {
    const fixture = await render({
      deployedRevision: {
        id: 'revision-2',
        number: 2,
        summary: { services: ['web'], networks: [], volumes: ['db-data', 'uploads'] },
      },
    });

    expect(textOf(fixture)).toContain('db-data');
    expect(textOf(fixture)).toContain('uploads');
  });

  /* A deployed stack has to be named back before the action is offered. */
  it('asks for the stack name before deleting a deployed one', async () => {
    const fixture = await render({});

    expect(textOf(fixture)).toContain('to confirm');
    expect(textOf(fixture)).toContain('shop');
  });

  it('does not ask for it when nothing is deployed', async () => {
    const fixture = await render({ deployedRevision: null, status: 'not_deployed' });

    expect(textOf(fixture)).not.toContain('to confirm');
  });

  it('has no accessibility violations', async () => {
    const fixture = await render({});
    const { violations } = await checkAccessibility(fixture);

    expect(violations.join('\n\n')).toBe('');
  });
});

/**
 * Which host resource a stack is on.
 *
 * A machine enrolled more than once leaves a host resource behind for every
 * enrolment, and they all report the same system hostname. A stack page that
 * names only the hostname therefore cannot say which of them it means, which is
 * exactly the question somebody looking at a stack has.
 */
describe('the host a stack is on', () => {
  const named = stack({ hostName: 'rc4-smoke', hostname: 'docker-01' });

  describe('in the list', () => {
    const render = (stacks: Stack[]) =>
      renderView(StackList, { data: { stacks }, permissions: ['stacks.read'] });

    it('leads with the name the host was given', async () => {
      const shown = textOf(await render([named]));

      expect(shown).toContain('rc4-smoke');
      expect(shown).toContain('docker-01');
    });

    it('says only the hostname for a host that has no name of its own', async () => {
      const fixture = await render([stack({ hostName: 'docker-01', hostname: 'docker-01' })]);
      const cell = (fixture.nativeElement as HTMLElement).querySelector('tbody td');

      expect(cell?.textContent?.match(/docker-01/g)).toHaveLength(1);
    });

    /* The regression: two stacks, two host resources, one system hostname. */
    it('tells two host identities that report one hostname apart', async () => {
      const shown = textOf(
        await render([
          named,
          stack({ id: 'stack-2', name: 'blog', hostId: 'host-2', hostName: 'stable-smoke' }),
        ]),
      );

      expect(shown).toContain('rc4-smoke');
      expect(shown).toContain('stable-smoke');
    });

    it('finds a stack by the name its host was given', async () => {
      const fixture = await render([named]);
      const search = (fixture.nativeElement as HTMLElement).querySelector('input');

      search!.value = 'rc4';
      search!.dispatchEvent(new Event('input'));
      fixture.detectChanges();

      expect(textOf(fixture)).toContain('shop');
    });
  });

  describe('on the page', () => {
    const render = (overrides: Partial<Stack>) =>
      renderView(StackDetail, {
        params: { id: 'stack-1' },
        data: { stacks: [stack(overrides)] },
        permissions: ['stacks.read', 'stacks.deploy'] as never,
      });

    it('names the host resource, and the machine beneath it', async () => {
      const shown = textOf(await render({ hostName: 'rc4-smoke', hostname: 'docker-01' }));

      expect(shown).toContain('rc4-smoke');
      expect(shown).toContain('System hostname: docker-01');
    });

    it('does not repeat a hostname that is already the name', async () => {
      const shown = textOf(await render({ hostName: 'docker-01', hostname: 'docker-01' }));

      expect(shown).not.toContain('System hostname');
    });
  });
});
