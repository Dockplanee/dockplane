import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';

import { PageContext } from '../../core/page-context';
import { DockplaneApi } from '../../data/dockplane-api';
import { Icon } from '../../ui/icon/icon';
import { Panel } from '../../ui/panel/panel';
import { SelectFilter } from '../../ui/select-filter/select-filter';
import { ComposeTable } from '../shared/compose-table';

@Component({
  selector: 'dp-compose-list',
  imports: [ComposeTable, Icon, Panel, SelectFilter],
  template: `
    <dp-panel flush>
      <div class="dp-controls">
        <div class="dp-controls__search">
          <label class="dp-sr-only" for="compose-search">Search Compose projects</label>
          <dp-icon name="search" class="dp-controls__search-icon" />
          <input
            id="compose-search"
            class="dp-field"
            type="search"
            placeholder="Search Compose projects"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
        </div>

        <dp-select-filter
          id="compose-host"
          label="Filter by host"
          [options]="hostOptions()"
          [value]="hostFilter()"
          (valueChange)="hostFilter.set($event)"
        />

        <dp-select-filter
          id="compose-state"
          label="Filter by state"
          [options]="stateOptions"
          [value]="stateFilter()"
          (valueChange)="stateFilter.set($event)"
        />
      </div>

      <dp-compose-table [projects]="filtered()" [total]="projects().length" />
    </dp-panel>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposeList {
  private readonly api = inject(DockplaneApi);

  protected readonly query = signal('');
  protected readonly hostFilter = signal('all');
  protected readonly stateFilter = signal('all');

  protected readonly projects = toSignal(this.api.composeProjects(), { initialValue: [] });
  private readonly hosts = toSignal(this.api.hosts(), { initialValue: [] });

  protected readonly stateOptions = [
    { value: 'all', label: 'All states' },
    { value: 'running', label: 'Running' },
    { value: 'degraded', label: 'Degraded' },
    { value: 'stopped', label: 'Stopped' },
    { value: 'failed', label: 'Failed' },
  ];

  protected readonly hostOptions = computed(() => [
    { value: 'all', label: 'All hosts' },
    ...this.hosts().map((host) => ({ value: host.id, label: host.name })),
  ]);

  protected readonly filtered = computed(() => {
    const term = this.query().trim().toLowerCase();
    const host = this.hostFilter();
    const state = this.stateFilter();

    return this.projects().filter((project) => {
      const matchesTerm =
        !term ||
        project.name.toLowerCase().includes(term) ||
        project.hostname.toLowerCase().includes(term);

      return (
        matchesTerm &&
        (host === 'all' || project.hostId === host) &&
        (state === 'all' || project.state === state)
      );
    });
  });

  constructor() {
    inject(PageContext).set({
      title: 'Compose',
      subtitle: 'Discovered Docker Compose projects',
    });
  }
}
