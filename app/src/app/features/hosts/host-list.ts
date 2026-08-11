import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';

import { relativeTime } from '../../core/format';
import { PageContext } from '../../core/page-context';
import { createSort } from '../../core/sorting';
import { DockplaneApi } from '../../data/dockplane-api';
import { Host } from '../../domain/inventory';
import { hostStatus, isReporting } from '../../domain/status';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { Icon } from '../../ui/icon/icon';
import { Meter } from '../../ui/meter/meter';
import { Panel } from '../../ui/panel/panel';
import { SelectFilter } from '../../ui/select-filter/select-filter';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { SortButton } from '../../ui/table/sort-button';
import { TableShell } from '../../ui/table/table-shell';

type Column = 'name' | 'status' | 'os' | 'containers' | 'cpu' | 'memory' | 'disk' | 'lastSeen';

@Component({
  selector: 'dp-host-list',
  imports: [
    RouterLink,
    Button,
    ConfirmDialog,
    EmptyState,
    Icon,
    Meter,
    Panel,
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

  private readonly enrollDialog = viewChild.required(ConfirmDialog);
  private readonly enrollTrigger = viewChild.required<ElementRef<HTMLElement>>('enrollTrigger');

  protected readonly query = signal('');
  protected readonly statusFilter = signal('all');
  protected readonly osFilter = signal('all');

  protected readonly hosts = toSignal(this.api.hosts(), { initialValue: [] });
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

  protected openEnrollment(): void {
    this.enrollDialog().open();
  }

  protected closeEnrollment(): void {
    this.enrollDialog().close();
    this.enrollTrigger().nativeElement.focus();
  }
}
