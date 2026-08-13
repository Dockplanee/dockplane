import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { relativeTime, timestamp } from '../../core/format';
import { STACK_STATE_LABELS } from '../../domain/stacks';
import { Panel } from '../../ui/panel/panel';
import { DetailItem, DetailList } from '../shared/detail-list';
import { StackStore } from './stack-store';

/**
 * What a stack is, at a glance.
 *
 * Saved and running are two entries rather than one, everywhere: they answer
 * different questions and are equally often the thing somebody came to check.
 */
@Component({
  selector: 'dp-stack-overview-tab',
  imports: [DetailList, Panel],
  template: `
    <dp-panel heading="Stack" icon="compose">
      <dp-detail-list [items]="details()" />
    </dp-panel>

    <dp-panel heading="What the running revision defines" icon="networks" class="stacked">
      @if (summary(); as revision) {
        <div class="groups">
          <div>
            <h4>Services</h4>
            <ul class="tokens">
              @for (service of revision.services; track service) {
                <li class="dp-mono">{{ service }}</li>
              } @empty {
                <li class="none">None</li>
              }
            </ul>
          </div>
          <div>
            <h4>Networks</h4>
            <ul class="tokens">
              @for (network of revision.networks; track network) {
                <li class="dp-mono">{{ network }}</li>
              } @empty {
                <li class="none">None</li>
              }
            </ul>
          </div>
          <div>
            <h4>Volumes</h4>
            <ul class="tokens">
              @for (volume of revision.volumes; track volume) {
                <li class="dp-mono">{{ volume }}</li>
              } @empty {
                <li class="none">None</li>
              }
            </ul>
          </div>
        </div>

        <p class="note">
          Dockplane does not delete a stack's volumes when a revision is applied or rolled back. A
          volume a revision no longer uses stays on the host.
        </p>
      } @else {
        <p class="none">Nothing has been deployed yet, so nothing has been created on the host.</p>
      }
    </dp-panel>
  `,
  styles: `
    .stacked {
      margin-top: 0.75rem;
    }

    .groups {
      display: grid;
      gap: 1rem 1.5rem;
      grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    }

    h4 {
      margin: 0 0 0.5rem;
      color: var(--dp-fg-muted);
      font-size: 0.6875rem;
      font-family: var(--font-mono);
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .tokens {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .tokens li {
      padding: 0.1875rem 0.5rem;
      border: 1px solid var(--dp-line);
      border-radius: var(--dp-radius-sm);
      background-color: var(--dp-surface-inset);
      font-size: 0.75rem;
    }

    .none {
      border: 0;
      padding: 0;
      background: none;
      color: var(--dp-fg-muted);
      font-size: 0.8125rem;
    }

    .note {
      margin-top: 1rem;
      color: var(--dp-fg-muted);
      font-size: 0.8125rem;
      max-width: 78ch;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StackOverviewTab {
  protected readonly store = inject(StackStore);

  /** The revision that is running where there is one, else what was saved. */
  protected readonly summary = computed(() => {
    const stack = this.store.stack();

    return (stack?.deployedRevision ?? stack?.latestRevision)?.summary ?? undefined;
  });

  protected readonly details = computed((): readonly DetailItem[] => {
    const stack = this.store.stack();
    const state = this.store.state();

    if (!stack) {
      return [];
    }

    return [
      { label: 'Host', value: stack.hostname },
      { label: 'Status', value: state ? STACK_STATE_LABELS[state] : '—' },
      {
        label: 'Saved revision',
        value: stack.latestRevision ? `#${stack.latestRevision.number}` : '—',
        mono: true,
      },
      {
        label: 'Deployed revision',
        value: stack.deployedRevision ? `#${stack.deployedRevision.number}` : 'Not deployed',
        mono: true,
      },
      { label: 'Services', value: String(this.summary()?.services.length ?? 0), mono: true },
      {
        label: 'Last deployed',
        value: stack.lastDeployedAt ? timestamp(stack.lastDeployedAt) : 'Never',
      },
      { label: 'Updated', value: relativeTime(stack.updatedAt) },
      { label: 'Management', value: 'Managed by Dockplane' },
    ];
  });
}
