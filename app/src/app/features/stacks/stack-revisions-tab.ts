import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { timestamp } from '../../core/format';
import { Permissions } from '../../core/permissions';
import { APPLY_LABELS, StackRevision, applyKind, stackState } from '../../domain/stacks';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { Panel } from '../../ui/panel/panel';
import { TableShell } from '../../ui/table/table-shell';
import { StackApply } from './stack-apply';
import { StackStore } from './stack-store';

/**
 * Everything this stack has ever been configured to be.
 *
 * A revision is immutable, which is what makes the history worth having: any
 * one of them can be applied again, and going back to an earlier one is exactly
 * that rather than a separate mechanism.
 *
 * The action offered per row is named for what it would do. Going backwards is
 * called a rollback because that is what an operator is doing, even though the
 * server is being asked the same thing either way.
 */
@Component({
  selector: 'dp-stack-revisions-tab',
  imports: [Button, EmptyState, Panel, TableShell],
  template: `
    <dp-panel flush>
      @if (revisions().length > 0) {
        <dp-table-shell
          [count]="revisions().length"
          [total]="revisions().length"
          noun="revision"
          nounPlural="revisions"
          minWidth="44rem"
        >
          <table class="dp-table">
            <caption>
              Saved revisions of this stack
            </caption>
            <thead>
              <tr>
                <th scope="col">Revision</th>
                <th scope="col">Saved</th>
                <th scope="col">Services</th>
                <th scope="col">State</th>
                <th scope="col"><span class="dp-sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (revision of revisions(); track revision.id) {
                <tr>
                  <th scope="row" class="dp-mono">#{{ revision.number }}</th>
                  <td class="dp-unknown">{{ when(revision) }}</td>
                  <td class="dp-mono">{{ revision.summary?.services?.length ?? '—' }}</td>
                  <td>
                    <span class="badges">
                      @if (revision.deployed) {
                        <span class="badge badge--running">Running</span>
                      }
                      @if (revision.latest) {
                        <span class="badge">Latest saved</span>
                      }
                    </span>
                  </td>
                  <td class="shrink">
                    @if (actionFor(revision); as label) {
                      <button
                        type="button"
                        dpButton
                        variant="secondary"
                        [disabled]="!!blocked()"
                        [attr.title]="blocked() || null"
                        (click)="request(revision)"
                      >
                        {{ label }}
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </dp-table-shell>
      } @else {
        <dp-empty-state icon="compose" title="No revisions" detail="Nothing has been saved yet." />
      }
    </dp-panel>
  `,
  styles: `
    :host {
      display: block;
    }

    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem;
    }

    /* A word, not a colour: the badge says what it means in greyscale too. */
    .badge {
      padding: 0.125rem 0.4375rem;
      border: 1px solid var(--dp-line);
      border-radius: var(--dp-radius-sm);
      color: var(--dp-fg-muted);
      font-size: 0.6875rem;
      white-space: nowrap;
    }

    .badge--running {
      border-color: var(--dp-status-ok);
      color: var(--dp-status-ok);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StackRevisionsTab {
  private readonly store = inject(StackStore);
  private readonly apply = inject(StackApply);
  private readonly permissions = inject(Permissions);

  protected readonly revisions = computed(() => this.store.revisions());

  protected readonly when = (revision: StackRevision) => timestamp(revision.createdAt);

  /** Why nothing can be applied right now, when that is the case. */
  protected readonly blocked = computed((): string | undefined => {
    if (!this.permissions.has('stacks.deploy')) {
      return 'You do not have permission to deploy stacks.';
    }

    return this.store.state() === 'reconciling'
      ? 'Dockplane is still establishing what happened on the host.'
      : undefined;
  });

  /**
   * What applying this revision would be called, or nothing.
   *
   * The revision that is already running has no action: applying it would
   * recreate every container to arrive back where it started. A stack that
   * needs attention is the exception, because there the point is the host
   * rather than the configuration.
   */
  protected actionFor(revision: StackRevision): string | undefined {
    const stack = this.store.stack();

    if (!stack) {
      return undefined;
    }

    if (revision.deployed && stackState(stack) !== 'needs_attention') {
      return undefined;
    }

    return APPLY_LABELS[applyKind(stack, revision)](revision.number);
  }

  protected request(revision: StackRevision): void {
    this.apply.request({ id: revision.id, number: revision.number, summary: revision.summary });
  }
}
