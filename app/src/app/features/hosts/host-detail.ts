import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { PageContext } from '../../core/page-context';
import { hostStatus } from '../../domain/status';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { Panel } from '../../ui/panel/panel';
import { StaleNotice } from '../../ui/stale-notice/stale-notice';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { TabBar } from '../../ui/tabs/tab-bar';
import { HostStore } from './host-store';

const TABS = [
  { label: 'Overview', path: 'overview' },
  { label: 'Containers', path: 'containers' },
  { label: 'Compose', path: 'compose' },
];

@Component({
  selector: 'dp-host-detail',
  imports: [RouterOutlet, EmptyState, Panel, StaleNotice, StatusBadge, TabBar],
  templateUrl: './host-detail.html',
  styleUrl: './host-detail.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [HostStore],
})
export class HostDetail {
  private readonly page = inject(PageContext);
  protected readonly store = inject(HostStore);

  protected readonly tabs = TABS;
  protected readonly status = hostStatus;

  protected readonly meta = computed(() => {
    const host = this.store.host();

    if (!host) {
      return [];
    }

    return [host.os, `Docker ${host.dockerVersion}`, `Agent ${host.agentVersion}`].filter(
      (entry): entry is string => Boolean(entry),
    );
  });

  constructor() {
    effect(() => {
      const host = this.store.host();

      this.page.set({
        title: host?.name ?? 'Host',
        breadcrumb: [{ label: 'Hosts', path: '/hosts' }, { label: host?.name ?? this.store.id() }],
      });
    });
  }
}
