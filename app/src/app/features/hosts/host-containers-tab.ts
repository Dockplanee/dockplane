import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { Icon } from '../../ui/icon/icon';
import { Panel } from '../../ui/panel/panel';
import { SelectFilter } from '../../ui/select-filter/select-filter';
import { ContainerPanel } from '../shared/container-panel';
import { HostStore } from './host-store';

@Component({
  selector: 'dp-host-containers-tab',
  imports: [ContainerPanel, Icon, Panel, SelectFilter],
  template: `
    <dl class="counts">
      @for (count of counts(); track count.label) {
        <div>
          <dt class="dp-label">{{ count.label }}</dt>
          <dd [class.attention]="count.attention && count.value > 0">{{ count.value }}</dd>
        </div>
      }
    </dl>

    <dp-panel flush class="table-panel">
      <div class="dp-controls">
        <div class="dp-controls__search">
          <label class="dp-sr-only" for="host-container-search">Search containers</label>
          <dp-icon name="search" class="dp-controls__search-icon" />
          <input
            id="host-container-search"
            class="dp-field"
            type="search"
            placeholder="Search containers"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
        </div>

        <dp-select-filter
          id="host-container-state"
          label="Filter by state"
          [options]="stateOptions"
          [value]="stateFilter()"
          (valueChange)="stateFilter.set($event)"
        />
      </div>

      <dp-container-panel
        [containers]="filtered()"
        [total]="store.containers().length"
        [showHost]="false"
        emptyTitle="No containers on this host"
        emptyDetail="Containers appear here once the agent reports the workloads running on this host."
      />
    </dp-panel>
  `,
  styles: `
    .counts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(6rem, 1fr));
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }

    .counts div {
      padding: 0.75rem 0.875rem;
      border: 1px solid var(--dp-line);
      border-radius: var(--dp-radius-md);
      background-color: var(--dp-surface);
    }

    .counts dd {
      margin-top: 0.25rem;
      font-size: 1.25rem;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }

    .counts dd.attention {
      color: var(--dp-status-critical);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HostContainersTab {
  protected readonly store = inject(HostStore);

  protected readonly query = signal('');
  protected readonly stateFilter = signal('all');

  protected readonly stateOptions = [
    { value: 'all', label: 'All states' },
    { value: 'running', label: 'Running' },
    { value: 'stopped', label: 'Stopped' },
    { value: 'restarting', label: 'Restarting' },
    { value: 'failed', label: 'Failed' },
  ];

  protected readonly counts = computed(() => {
    const counts = this.store.counts();

    return [
      { label: 'Total', value: counts.total, attention: false },
      { label: 'Running', value: counts.running, attention: false },
      { label: 'Stopped', value: counts.stopped, attention: false },
      { label: 'Restarting', value: counts.restarting, attention: false },
      { label: 'Unhealthy', value: counts.unhealthy, attention: true },
    ];
  });

  protected readonly filtered = computed(() => {
    const term = this.query().trim().toLowerCase();
    const state = this.stateFilter();

    return this.store.containers().filter((container) => {
      const matchesTerm =
        !term ||
        container.name.toLowerCase().includes(term) ||
        container.image.toLowerCase().includes(term);

      return matchesTerm && (state === 'all' || container.state === state);
    });
  });
}
