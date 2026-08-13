import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { switchMap } from 'rxjs';

import { RouterLink } from '@angular/router';

import { InventoryRefresh } from '../../core/inventory-refresh';
import { Permissions } from '../../core/permissions';
import { PageContext } from '../../core/page-context';
import { DockplaneApi } from '../../data/dockplane-api';
import { Button } from '../../ui/button';
import { Icon } from '../../ui/icon/icon';
import { Panel } from '../../ui/panel/panel';
import { SelectFilter } from '../../ui/select-filter/select-filter';
import { ContainerPanel } from '../shared/container-panel';

@Component({
  selector: 'dp-container-list',
  imports: [RouterLink, Button, ContainerPanel, Icon, Panel, SelectFilter],
  template: `
    @if (canCreate()) {
      <div class="lead">
        <a dpButton variant="primary" routerLink="/containers/new">
          <dp-icon name="plus" />
          Create container
        </a>
      </div>
    }

    <dp-panel flush>
      <div class="dp-controls">
        <div class="dp-controls__search">
          <label class="dp-sr-only" for="container-search">Search containers</label>
          <dp-icon name="search" class="dp-controls__search-icon" />
          <input
            id="container-search"
            class="dp-field"
            type="search"
            placeholder="Search containers"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
        </div>

        <dp-select-filter
          id="container-host"
          label="Filter by host"
          [options]="hostOptions()"
          [value]="hostFilter()"
          (valueChange)="hostFilter.set($event)"
        />

        <dp-select-filter
          id="container-state"
          label="Filter by state"
          [options]="stateOptions"
          [value]="stateFilter()"
          (valueChange)="stateFilter.set($event)"
        />

        <dp-select-filter
          id="container-health"
          label="Filter by health"
          [options]="healthOptions"
          [value]="healthFilter()"
          (valueChange)="healthFilter.set($event)"
        />
      </div>

      <dp-container-panel
        [containers]="filtered()"
        [total]="containers().length"
        emptyTitle="No containers found"
        emptyDetail="No container matches the current search and filters."
      />
    </dp-panel>
  `,
  styles: `
    .lead {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 0.75rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContainerList {
  private readonly api = inject(DockplaneApi);
  private readonly refresh = inject(InventoryRefresh);
  private readonly permissions = inject(Permissions);

  /*
   * Offered where it could succeed. The control server authorizes the request
   * again regardless — an absent button is a courtesy, not a boundary.
   */
  protected readonly canCreate = computed(() => this.permissions.has('containers.create'));

  protected readonly query = signal('');
  protected readonly hostFilter = signal('all');
  protected readonly stateFilter = signal('all');
  protected readonly healthFilter = signal('all');

  // Read again after every operation, so a row shows what the host reported
  // afterwards rather than the record that was on screen when it was asked.
  protected readonly containers = toSignal(
    this.refresh.changes.pipe(switchMap(() => this.api.containers())),
    { initialValue: [] },
  );
  private readonly hosts = toSignal(this.refresh.changes.pipe(switchMap(() => this.api.hosts())), {
    initialValue: [],
  });

  protected readonly stateOptions = [
    { value: 'all', label: 'All states' },
    { value: 'running', label: 'Running' },
    { value: 'stopped', label: 'Stopped' },
    { value: 'restarting', label: 'Restarting' },
    { value: 'failed', label: 'Failed' },
  ];

  protected readonly healthOptions = [
    { value: 'all', label: 'All health' },
    { value: 'healthy', label: 'Healthy' },
    { value: 'unhealthy', label: 'Unhealthy' },
    { value: 'starting', label: 'Starting' },
    { value: 'none', label: 'No health check' },
  ];

  protected readonly hostOptions = computed(() => [
    { value: 'all', label: 'All hosts' },
    ...this.hosts().map((host) => ({ value: host.id, label: host.name })),
  ]);

  protected readonly filtered = computed(() => {
    const term = this.query().trim().toLowerCase();
    const host = this.hostFilter();
    const state = this.stateFilter();
    const health = this.healthFilter();

    return this.containers().filter((container) => {
      const matchesTerm =
        !term ||
        container.name.toLowerCase().includes(term) ||
        container.image.toLowerCase().includes(term);

      return (
        matchesTerm &&
        (host === 'all' || container.hostId === host) &&
        (state === 'all' || container.state === state) &&
        (health === 'all' || container.health === health)
      );
    });
  });

  constructor() {
    inject(PageContext).set({
      title: 'Containers',
      subtitle: 'All containers across connected hosts',
    });
  }
}
