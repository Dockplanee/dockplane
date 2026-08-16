import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { switchMap } from 'rxjs';

import { relativeTime } from '../../core/format';
import { PageContext } from '../../core/page-context';
import { ApiError } from '../../core/api-error';
import { Permissions } from '../../core/permissions';
import { createSort } from '../../core/sorting';
import { DockplaneApi } from '../../data/dockplane-api';
import { Host, HostScope } from '../../domain/inventory';
import { hostStatus, isReporting } from '../../domain/status';
import { Button } from '../../ui/button';
import { AddHostDialog } from './add-host-dialog';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { Icon } from '../../ui/icon/icon';
import { LastKnown } from '../../ui/last-known/last-known';
import { Meter } from '../../ui/meter/meter';
import { Panel } from '../../ui/panel/panel';
import { SelectFilter } from '../../ui/select-filter/select-filter';
import { ConfirmDetail, ConfirmDialog } from '../../ui/confirm-dialog/confirm-dialog';
import { RowAction, RowMenu } from '../../ui/row-menu/row-menu';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { SortButton } from '../../ui/table/sort-button';
import { TableShell } from '../../ui/table/table-shell';

type Column = 'name' | 'status' | 'os' | 'containers' | 'cpu' | 'memory' | 'disk' | 'lastSeen';

@Component({
  selector: 'dp-host-list',
  imports: [
    RouterLink,
    Button,
    AddHostDialog,
    EmptyState,
    Icon,
    LastKnown,
    Meter,
    Panel,
    ConfirmDialog,
    RowMenu,
    SelectFilter,
    SortButton,
    StatusBadge,
    TableShell,
  ],
  templateUrl: './host-list.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HostList {
  private readonly api = inject(DockplaneApi);

  private readonly addHostDialog = viewChild.required(AddHostDialog);
  private readonly addHostTrigger = viewChild.required<ElementRef<HTMLElement>>('addHostTrigger');

  private readonly permissions = inject(Permissions);

  private readonly archiveDialog = viewChild.required('archiveDialog', { read: ConfirmDialog });

  protected readonly query = signal('');
  protected readonly statusFilter = signal('all');
  protected readonly osFilter = signal('all');

  /*
   * The working set by default. Archived hosts are not gone and are one filter
   * away, which is what keeps this a lifecycle state rather than a deletion.
   */
  protected readonly scope = signal<HostScope>('active');

  protected readonly selected = signal<Host | undefined>(undefined);
  protected readonly working = signal(false);
  protected readonly failure = signal<{ message: string; requestId?: string } | undefined>(
    undefined,
  );

  /** Bumped after a change, so the list reflects the server's answer. */
  private readonly reload = signal(0);

  protected readonly hosts = toSignal(
    toObservable(computed(() => ({ scope: this.scope(), reload: this.reload() }))).pipe(
      switchMap(({ scope }) => this.api.hosts(scope)),
    ),
    { initialValue: [] },
  );

  protected readonly canArchive = this.permissions.has('hosts.archive');

  protected readonly scopeOptions = [
    { value: 'active', label: 'Active hosts' },
    { value: 'archived', label: 'Archived hosts' },
    { value: 'all', label: 'All hosts' },
  ];
  private readonly containers = toSignal(this.api.containers(), { initialValue: [] });

  protected readonly statusOptions = [
    { value: 'all', label: 'All status' },
    { value: 'healthy', label: 'Healthy' },
    { value: 'warning', label: 'Warning' },
    { value: 'critical', label: 'Critical' },
    { value: 'offline', label: 'Offline' },
  ];

  protected readonly osOptions = computed(() => [
    { value: 'all', label: 'All operating systems' },
    ...[
      ...new Set(
        this.hosts()
          .map((host) => host.os)
          .filter((os): os is string => !!os),
      ),
    ].map((os) => ({ value: os, label: os })),
  ]);

  private readonly filtered = computed(() => {
    const term = this.query().trim().toLowerCase();
    const status = this.statusFilter();
    const os = this.osFilter();

    return this.hosts().filter((host) => {
      const matchesTerm =
        !term ||
        host.name.toLowerCase().includes(term) ||
        (host.os ?? '').toLowerCase().includes(term);

      return (
        matchesTerm &&
        (status === 'all' || host.status === status) &&
        (os === 'all' || host.os === os)
      );
    });
  });

  private readonly sort = createSort<Host, Column>(
    this.filtered,
    {
      name: (host) => host.name,
      status: (host) => host.status,
      os: (host) => host.os ?? '',
      containers: (host) => this.containerCount(host).running,
      cpu: (host) => host.cpu?.percent,
      memory: (host) => host.memory?.percent,
      disk: (host) => host.disk?.percent,
      lastSeen: (host) => (host.lastSeen ? new Date(host.lastSeen).getTime() : 0),
    },
    { key: 'name', direction: 'asc' },
  );

  protected readonly rows = this.sort.sorted;

  /** Containers this host owns, counted from the list the server returned. */
  protected containerCount(host: Host): { running: number; total: number } {
    const owned = this.containers().filter((container) => container.hostId === host.id);

    return {
      running: owned.filter((container) => container.state === 'running').length,
      total: owned.length,
    };
  }
  protected readonly sortState = this.sort.state;

  protected readonly status = hostStatus;
  protected readonly reporting = isReporting;
  protected readonly age = relativeTime;

  constructor() {
    inject(PageContext).set({ title: 'Hosts', subtitle: 'All Docker hosts' });
  }

  /*
   * What an operator may do with a row.
   *
   * Archiving is offered for a host that is not archived and not connected; a
   * connected host is in use, and taking a working machine out of the lists
   * that manage it is not what archiving is for. The server decides the same
   * question again when the request arrives, because an agent can reconnect in
   * between.
   */
  protected actionsFor(host: Host): readonly RowAction[] {
    if (!this.canArchive) {
      return [];
    }

    if (host.archived) {
      return [{ id: 'unarchive', label: 'Restore host' }];
    }

    return [
      {
        id: 'archive',
        label: 'Archive host',
        disabled: host.status !== 'offline' && host.status !== 'critical',
        hint: 'The host has a connected agent, so it is in use.',
      },
    ];
  }

  protected run(host: Host, action: string): void {
    this.failure.set(undefined);
    this.selected.set(host);

    if (action === 'unarchive') {
      this.unarchive(host);
      return;
    }

    this.archiveDialog().open();
  }

  protected readonly archiveDetails = computed<readonly ConfirmDetail[]>(() => {
    const host = this.selected();

    if (!host) {
      return [];
    }

    return [
      { label: 'Host', value: host.name },
      { label: 'System hostname', value: host.hostname },
      { label: 'Containers on record', value: String(this.containerCount(host).total) },
    ];
  });

  protected confirmArchive(): void {
    const host = this.selected();

    if (!host) {
      return;
    }

    this.working.set(true);

    this.api.archiveHost(host.id).subscribe({
      next: () => {
        this.working.set(false);
        this.reload.update((value) => value + 1);
      },
      error: (error: unknown) => {
        this.working.set(false);
        this.failure.set(describe(error));
      },
    });
  }

  private unarchive(host: Host): void {
    this.working.set(true);

    this.api.unarchiveHost(host.id).subscribe({
      next: () => {
        this.working.set(false);
        this.reload.update((value) => value + 1);
      },
      error: (error: unknown) => {
        this.working.set(false);
        this.failure.set(describe(error));
      },
    });
  }

  protected toggleSort(column: Column): void {
    this.sort.toggle(column);
  }

  protected ariaSort(column: Column) {
    return this.sort.ariaSort(column);
  }

  protected directionFor(column: Column) {
    const state = this.sortState();
    return state.key === column ? state.direction : undefined;
  }

  protected openAddHost(): void {
    // The dialog returns focus to whatever opened it when it closes.
    this.addHostDialog().open(this.addHostTrigger().nativeElement);
  }
}

/**
 * What to tell somebody when the server refuses.
 *
 * A host that reconnected between the page rendering and the request arriving
 * is the expected refusal, and it is not a fault in what they did.
 */
function describe(error: unknown): { message: string; requestId?: string } {
  if (error instanceof ApiError) {
    return { message: error.message, requestId: error.requestId };
  }

  return { message: 'The host could not be changed.' };
}
