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
  hostname: 'docker-01',
  sourceType: 'dockplane',
  status: 'running',
  latestRevision: { id: 'revision-2', number: 2, summary: { services: ['web'], networks: [], volumes: [] } },
  runningRevision: { id: 'revision-2', number: 2, summary: { services: ['web'], networks: [], volumes: [] } },
  reconciling: false,
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
            runningRevision: { id: 'revision-2', number: 2 },
          }),
        ],
      },
      permissions: ['stacks.read'],
    });

    expect(textOf(fixture)).toContain('Changes not deployed');
  });

  it('says when a stack has never been deployed', async () => {
    const fixture = await renderView(StackList, {
      data: { stacks: [stack({ runningRevision: null, status: 'not_deployed' })] },
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
            runningRevision: { id: 'revision-2', number: 2 },
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
      { latestRevision: { id: 'revision-3', number: 3 }, runningRevision: { id: 'revision-2', number: 2 } },
      ['stacks.read', 'stacks.update', 'stacks.deploy'],
    );

    expect(textOf(fixture)).toContain('Edit configuration');
    expect(textOf(fixture)).toContain('Deploy revision #3');
  });

  it('offers neither to somebody who may only look', async () => {
    const fixture = await render(
      { latestRevision: { id: 'revision-3', number: 3 }, runningRevision: { id: 'revision-2', number: 2 } },
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
      { latestRevision: { id: 'revision-1', number: 1 }, runningRevision: { id: 'revision-2', number: 2 } },
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
