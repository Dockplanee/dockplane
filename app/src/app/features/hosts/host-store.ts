import { Injectable, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { combineLatest, map, switchMap } from 'rxjs';

import { InventoryRefresh } from '../../core/inventory-refresh';
import { DockplaneApi } from '../../data/dockplane-api';
import { isReporting } from '../../domain/status';

/**
 * State for one host detail view.
 *
 * Provided by the detail route so its tabs share a single load instead of each
 * tab querying the control server again.
 */
@Injectable()
export class HostStore {
  private readonly api = inject(DockplaneApi);
  private readonly route = inject(ActivatedRoute);
  private readonly refresh = inject(InventoryRefresh);

  private readonly params = this.route.paramMap;

  /** The host to read, re-emitted whenever an operation changed something. */
  private readonly target = combineLatest([this.params, this.refresh.changes]).pipe(
    map(([params]) => params.get('id') ?? ''),
  );

  readonly id = toSignal(this.params.pipe(map((params) => params.get('id') ?? '')), {
    initialValue: '',
  });

  readonly host = toSignal(this.target.pipe(switchMap((id) => this.api.host(id))), {
    initialValue: undefined,
  });

  private readonly allContainers = toSignal(
    this.refresh.changes.pipe(switchMap(() => this.api.containers())),
    { initialValue: [] },
  );
  private readonly allProjects = toSignal(
    this.refresh.changes.pipe(switchMap(() => this.api.composeProjects())),
    { initialValue: [] },
  );

  readonly containers = computed(() =>
    this.allContainers().filter((container) => container.hostId === this.id()),
  );
  readonly projects = computed(() =>
    this.allProjects().filter((project) => project.hostId === this.id()),
  );

  /** False while the agent is offline, which makes every metric stale. */
  readonly reporting = computed(() => {
    const host = this.host();
    return host ? isReporting(host.status) : false;
  });

  readonly counts = computed(() => {
    const containers = this.containers();

    return {
      total: containers.length,
      running: containers.filter((container) => container.state === 'running').length,
      stopped: containers.filter((container) => container.state === 'stopped').length,
      restarting: containers.filter((container) => container.state === 'restarting').length,
      unhealthy: containers.filter((container) => container.health === 'unhealthy').length,
    };
  });
}
