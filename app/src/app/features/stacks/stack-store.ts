import { Injectable, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { combineLatest, map, of, switchMap } from 'rxjs';

import { InventoryRefresh } from '../../core/inventory-refresh';
import { DockplaneApi } from '../../data/dockplane-api';
import { StackRevision, StackService, stackState } from '../../domain/stacks';

/**
 * State for one stack detail view, shared by its sections.
 *
 * Everything is re-read when an operation reports that something changed, which
 * is how applying a revision updates the running revision, the history and the
 * services at once. Nothing here holds a Compose file: the source is fetched by
 * the editor that needs it and lives in that page's own state.
 */
@Injectable()
export class StackStore {
  private readonly api = inject(DockplaneApi);
  private readonly route = inject(ActivatedRoute);
  private readonly refresh = inject(InventoryRefresh);

  private readonly params = this.route.paramMap;

  private readonly target = combineLatest([this.params, this.refresh.changes]).pipe(
    map(([params]) => params.get('id') ?? ''),
  );

  readonly id = toSignal(this.params.pipe(map((params) => params.get('id') ?? '')), {
    initialValue: '',
  });

  readonly stack = toSignal(this.target.pipe(switchMap((id) => this.api.stack(id))), {
    initialValue: undefined,
  });

  readonly revisions = toSignal(
    this.target.pipe(
      switchMap((id) => (id ? this.api.stackRevisions(id) : of([] as readonly StackRevision[]))),
    ),
    { initialValue: [] as readonly StackRevision[] },
  );

  readonly services = toSignal(
    this.target.pipe(
      switchMap((id) => (id ? this.api.stackServices(id) : of([] as readonly StackService[]))),
    ),
    { initialValue: [] as readonly StackService[] },
  );

  readonly state = computed(() => {
    const stack = this.stack();

    return stack ? stackState(stack) : undefined;
  });

  /** Re-reads everything this view shows. */
  reload(): void {
    this.refresh.request();
  }
}
