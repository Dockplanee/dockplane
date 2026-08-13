import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

import { PageContext } from '../../core/page-context';
import { Permissions } from '../../core/permissions';
import {
  APPLY_LABELS,
  OPERATION_LABELS,
  STACK_STATE_LABELS,
  STACK_STATE_TONES,
  Stack,
  StackOperation,
  applyKind,
  stackState,
} from '../../domain/stacks';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { Panel } from '../../ui/panel/panel';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { TabBar } from '../../ui/tabs/tab-bar';
import { StackApply } from './stack-apply';
import { StackApplyDialog } from './stack-apply-dialog';
import { StackOperate } from './stack-operate';
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
    ConfirmDialog,
    EmptyState,
    Panel,
    StackApplyDialog,
    StatusBadge,
    TabBar,
  ],
  templateUrl: './stack-detail.html',
  styleUrl: './stack-detail.css',
  providers: [StackStore, StackApply, StackOperate],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StackDetail {
  protected readonly store = inject(StackStore);
  protected readonly apply = inject(StackApply);
  protected readonly operate = inject(StackOperate);
  private readonly permissions = inject(Permissions);
  private readonly page = inject(PageContext);

  protected readonly tabs = TABS;

  protected readonly state = computed(() => this.store.state());

  protected readonly canEdit = computed(() => this.permissions.has('stacks.update'));
  protected readonly canDeploy = computed(() => this.permissions.has('stacks.deploy'));

  protected readonly latest = computed(() => this.store.stack()?.latestRevision ?? null);
  protected readonly deployed = computed(() => this.store.stack()?.deployedRevision ?? null);

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
    if (stack.deployedRevision?.id === latest.id && stackState(stack) !== 'needs_attention') {
      return null;
    }

    return latest;
  });

  protected readonly applyLabel = computed(() => {
    const stack = this.store.stack();
    const target = this.applicable();

    return stack && target ? APPLY_LABELS[applyKind(stack, target)](target.number) : '';
  });

  private readonly operationDialog = viewChild<ConfirmDialog>('operationDialog');

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

    /*
     * The dialog follows what is waiting to be confirmed rather than being
     * opened by the button. One source of truth for whether a confirmation is
     * open, which is what stops a dismissed dialog leaving an operation
     * half-requested behind it.
     */
    effect(() => {
      const dialog = this.operationDialog();

      if (!dialog) {
        return;
      }

      if (this.operate.pending()) {
        dialog.open();
      } else {
        dialog.close();
      }
    });
  }

  protected operationLabel(operation: StackOperation): string {
    return OPERATION_LABELS[operation];
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
