import { Injectable, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { combineLatest, map, of, switchMap } from 'rxjs';

import { InventoryRefresh } from '../../core/inventory-refresh';
import { DockplaneApi } from '../../data/dockplane-api';
import { Container } from '../../domain/inventory';

/**
 * State for one Compose project detail view, shared by its tabs.
 *
 * The project detail carries its own services, read from the host through
 * `compose.inspect`. The containers it owns come from the registry, so a
 * project whose host has gone quiet still shows what belongs to it.
 */
@Injectable()
export class ComposeStore {
  private readonly api = inject(DockplaneApi);
  private readonly route = inject(ActivatedRoute);
  private readonly refresh = inject(InventoryRefresh);

  private readonly params = this.route.paramMap;

  /** The project to read, re-emitted whenever an operation changed something. */
  private readonly target = combineLatest([this.params, this.refresh.changes]).pipe(
    map(([params]) => params.get('id') ?? ''),
  );

  readonly id = toSignal(this.params.pipe(map((params) => params.get('id') ?? '')), {
    initialValue: '',
  });

  readonly project = toSignal(this.target.pipe(switchMap((id) => this.api.composeProject(id))), {
    initialValue: undefined,
  });

  readonly services = computed(() => this.project()?.services ?? []);

  /**
   * The containers this project owns.
   *
   * Read from the container list filtered by project rather than from the
   * project's own summary: the list carries everything a container row needs,
   * and it is the same record the containers view links to.
   */
  private readonly members = toSignal(
    this.target.pipe(
      switchMap((id) => this.api.composeProject(id)),
      switchMap((project) =>
        project ? this.api.containers({ project: project.name }) : of([] as readonly Container[]),
      ),
    ),
    { initialValue: [] as readonly Container[] },
  );

  readonly containers = this.members;

  readonly stale = computed(() => this.project()?.stale ?? true);
}
