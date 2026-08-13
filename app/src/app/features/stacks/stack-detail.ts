import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

import { PageContext } from '../../core/page-context';
import { Permissions } from '../../core/permissions';
import {
  APPLY_LABELS,
  STACK_STATE_LABELS,
  STACK_STATE_TONES,
  Stack,
  applyKind,
  stackState,
} from '../../domain/stacks';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { Panel } from '../../ui/panel/panel';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { TabBar } from '../../ui/tabs/tab-bar';
import { StackApply } from './stack-apply';
import { StackApplyDialog } from './stack-apply-dialog';
import { StackStore } from './stack-store';

const TABS = [
  { label: 'Overview', path: 'overview' },
  { label: 'Revisions', path: 'revisions' },
  { label: 'Services', path: 'services' },
];

/**
 * One stack.
 *
 * The header answers the two questions an operator has about a stack before any
 * other: what is running, and is it what was last saved. Everything else is in
 * sections below.
 */
@Component({
  selector: 'dp-stack-detail',
  imports: [
    RouterLink,
    RouterOutlet,
    Button,
    EmptyState,
    Panel,
    StackApplyDialog,
    StatusBadge,
    TabBar,
  ],
  templateUrl: './stack-detail.html',
  styleUrl: './stack-detail.css',
  providers: [StackStore, StackApply],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StackDetail {
  protected readonly store = inject(StackStore);
  protected readonly apply = inject(StackApply);
  private readonly permissions = inject(Permissions);
  private readonly page = inject(PageContext);

  protected readonly tabs = TABS;

  protected readonly state = computed(() => this.store.state());

  protected readonly canEdit = computed(() => this.permissions.has('stacks.update'));
  protected readonly canDeploy = computed(() => this.permissions.has('stacks.deploy'));

  protected readonly latest = computed(() => this.store.stack()?.latestRevision ?? null);
  protected readonly running = computed(() => this.store.stack()?.runningRevision ?? null);

  /**
   * Whether a revision may be applied at all right now.
   *
   * Permission, a connected host, and no attempt still in flight. The reason is
   * carried with it so a disabled button can say why rather than looking broken.
   */
  protected readonly blocked = computed((): string | undefined => {
    const stack = this.store.stack();

    if (!stack) {
      return 'This stack no longer exists.';
    }

    if (!this.canDeploy()) {
      return 'You do not have permission to deploy stacks.';
    }

    if (this.state() === 'reconciling') {
      return 'Dockplane is still establishing what happened on the host.';
    }

    if (!stack.hostReachable) {
      return 'The host agent is offline.';
    }

    return undefined;
  });

  /** The revision the primary action would apply, when there is one to apply. */
  protected readonly applicable = computed(() => {
    const stack = this.store.stack();
    const latest = this.latest();

    if (!stack || !latest) {
      return null;
    }

    // Applying the revision that is already running does nothing, unless the
    // stack needs attention — where doing it again is exactly the repair.
    if (stack.runningRevision?.id === latest.id && stackState(stack) !== 'needs_attention') {
      return null;
    }

    return latest;
  });

  protected readonly applyLabel = computed(() => {
    const stack = this.store.stack();
    const target = this.applicable();

    return stack && target ? APPLY_LABELS[applyKind(stack, target)](target.number) : '';
  });

  constructor() {
    effect(() => {
      const stack = this.store.stack();

      if (stack) {
        this.page.set({
          title: stack.name,
          breadcrumb: [{ label: 'Stacks', path: '/stacks' }, { label: stack.name }],
        });
      }
    });
  }

  protected label(stack: Stack): string {
    return STACK_STATE_LABELS[stackState(stack)];
  }

  protected tone(stack: Stack) {
    return STACK_STATE_TONES[stackState(stack)];
  }

  protected requestApply(): void {
    const target = this.applicable();

    if (target) {
      this.apply.request(target);
    }
  }
}
