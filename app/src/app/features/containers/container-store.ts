import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { catchError, combineLatest, map, of, switchMap, tap } from 'rxjs';

import { ApiError } from '../../core/api-error';
import { InventoryRefresh } from '../../core/inventory-refresh';
import { DockplaneApi } from '../../data/dockplane-api';

/**
 * State for one container detail view, shared by its tabs.
 *
 * The summary and the detail are two reads. The summary comes from discovery
 * and is always available; the detail is read from the host when the view
 * opens, so it can fail on its own while the rest of the page still renders.
 */
@Injectable()
export class ContainerStore {
  private readonly api = inject(DockplaneApi);
  private readonly route = inject(ActivatedRoute);
  private readonly refresh = inject(InventoryRefresh);

  private readonly params = this.route.paramMap;

  /**
   * The container to read, re-emitted whenever something changed it.
   *
   * Both reads hang off this, so an operation that succeeded on the host is
   * followed by an observation rather than by the record that was on screen
   * before it ran.
   */
  private readonly target = combineLatest([this.params, this.refresh.changes]).pipe(
    map(([params]) => params.get('id') ?? ''),
  );

  private readonly detailError = signal<ApiError | undefined>(undefined);

  readonly id = toSignal(this.params.pipe(map((params) => params.get('id') ?? '')), {
    initialValue: '',
  });

  readonly container = toSignal(this.target.pipe(switchMap((id) => this.api.container(id))), {
    initialValue: undefined,
  });

  readonly detail = toSignal(
    this.target.pipe(
      tap(() => this.detailError.set(undefined)),
      switchMap((id) =>
        this.api.containerDetail(id).pipe(
          catchError((error: unknown) => {
            // A host that cannot be reached is an operational state, not a
            // broken page: the summary still renders and the tab says why the
            // detail is missing.
            this.detailError.set(ApiError.from(error));
            return of(undefined);
          }),
        ),
      ),
    ),
    { initialValue: undefined },
  );

  /** Why the detail could not be read, when it could not. */
  readonly unavailable = this.detailError.asReadonly();

  private readonly hosts = toSignal(this.refresh.changes.pipe(switchMap(() => this.api.hosts())), {
    initialValue: [],
  });

  readonly host = computed(() => this.hosts().find((host) => host.id === this.container()?.hostId));

  /** True when nothing is refreshing what is on screen. */
  readonly stale = computed(() => this.detail()?.stale ?? this.container()?.stale ?? true);

  readonly networks = computed(() => this.detail()?.networks ?? []);

  readonly mounts = computed(() => this.detail()?.mounts ?? []);

  /** When what is on screen was read, whichever read produced it. */
  readonly observedAt = computed(() => this.detail()?.observedAt ?? this.container()?.observedAt);
}
