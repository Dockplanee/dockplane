import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';

import { relativeTime, uptime } from '../../core/format';
import { PageContext } from '../../core/page-context';
import { DockplaneApi } from '../../data/dockplane-api';
import { ComposeProject, Container, Host } from '../../domain/inventory';
import { SEVERITY_ORDER, Severity, hostStatus, severity } from '../../domain/status';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { Icon, IconName } from '../../ui/icon/icon';
import { Meter } from '../../ui/meter/meter';
import { Panel } from '../../ui/panel/panel';
import { SelectFilter } from '../../ui/select-filter/select-filter';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { SummaryCard } from '../../ui/summary-card/summary-card';
import { TableShell } from '../../ui/table/table-shell';

const STATUS_FILTERS = [
  { value: 'all', label: 'All status' },
  { value: 'healthy', label: 'Healthy' },
  { value: 'unknown', label: 'Stale' },
  { value: 'offline', label: 'Offline' },
  { value: 'critical', label: 'Critical' },
];

/** Something an operator should look at, derived from state the server reports. */
export interface Attention {
  readonly id: string;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  readonly icon: IconName;
  readonly link: readonly string[];
  readonly since?: string;
}

@Component({
  selector: 'dp-overview',
  imports: [
    RouterLink,
    Button,
    EmptyState,
    Icon,
    Meter,
    Panel,
    SelectFilter,
    StatusBadge,
    SummaryCard,
    TableShell,
  ],
  templateUrl: './overview.html',
  styleUrl: './overview.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Overview {
  private readonly api = inject(DockplaneApi);

  protected readonly statusFilters = STATUS_FILTERS;
  protected readonly statusFilter = signal('all');

  protected readonly hosts = toSignal(this.api.hosts(), { initialValue: [] });
  private readonly containers = toSignal(this.api.containers(), { initialValue: [] });
  private readonly projects = toSignal(this.api.composeProjects(), { initialValue: [] });

  /**
   * Counts, and only counts.
   *
   * The control server keeps the current state of a fleet, not its history, so
   * there is no yesterday to compare against and no series to draw. A trend
   * line here would be decoration standing in for data that does not exist.
   */
  protected readonly cards = computed(() => {
    const containers = this.containers();
    const running = containers.filter((container) => container.state === 'running').length;
    const projects = this.projects();
    const attention = this.attention();

    return [
      {
        key: 'hosts',
        label: 'Hosts',
        icon: 'hosts' as const,
        tone: 'neutral' as const,
        value: String(this.hosts().length),
        detail: `${this.hosts().filter((host) => host.status !== 'offline').length} reporting`,
      },
      {
        key: 'containers',
        label: 'Containers',
        icon: 'containers' as const,
        tone: 'neutral' as const,
        value: String(containers.length),
        detail: `${running} running`,
      },
      {
        key: 'compose',
        label: 'Compose projects',
        icon: 'compose' as const,
        tone: 'neutral' as const,
        value: String(projects.length),
        detail: `${projects.filter((project) => project.state === 'running').length} running`,
      },
      {
        key: 'alerts',
        label: 'Needs attention',
        icon: 'health' as const,
        tone: attention.length > 0 ? ('critical' as const) : ('ok' as const),
        value: String(attention.length),
        detail: attention.length === 0 ? 'Nothing to report' : 'See below',
      },
    ];
  });

  /**
   * What needs attention, read off the current state.
   *
   * Every entry corresponds to something the server actually reports: an agent
   * that is not connected, a record nothing is refreshing, a container that
   * failed its health check or exited, a Compose project not fully up. Nothing
   * is inferred from a threshold the product has not defined.
   */
  protected readonly attention = computed<Attention[]>(() => {
    const issues: Attention[] = [
      ...this.hosts().flatMap(hostIssues),
      ...this.containers().flatMap(containerIssues),
      ...this.projects().flatMap(projectIssues),
    ];

    return issues.sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.title.localeCompare(b.title),
    );
  });

  protected readonly filteredHosts = computed(() => {
    const filter = this.statusFilter();

    return filter === 'all' ? this.hosts() : this.hosts().filter((host) => host.status === filter);
  });

  constructor() {
    inject(PageContext).set({
      title: 'Overview',
      subtitle: 'High level overview of your Docker environment',
    });
  }

  /** Containers the host reports, counted from the list the server returned. */
  protected containerCount(host: Host): { running: number; total: number } {
    const owned = this.containers().filter((container) => container.hostId === host.id);

    return {
      running: owned.filter((container) => container.state === 'running').length,
      total: owned.length,
    };
  }

  protected status = hostStatus;
  protected severity = severity;
  protected age = relativeTime;
  protected uptimeOf = uptime;
}

function hostIssues(host: Host): Attention[] {
  if (host.status === 'offline') {
    return [
      {
        id: `host-offline-${host.id}`,
        severity: 'critical',
        title: `${host.name} is offline`,
        detail: 'The agent is not connected, so nothing on this host is being refreshed.',
        icon: 'hosts',
        link: ['/hosts', host.id],
        since: host.lastSeen,
      },
    ];
  }

  if (host.stale) {
    return [
      {
        id: `host-stale-${host.id}`,
        severity: 'warning',
        title: `${host.name} has not reported recently`,
        detail: 'What is shown for this host is the last observation, not current state.',
        icon: 'hosts',
        link: ['/hosts', host.id],
        since: host.observedAt,
      },
    ];
  }

  return [];
}

function containerIssues(container: Container): Attention[] {
  if (container.health === 'unhealthy') {
    return [
      {
        id: `container-unhealthy-${container.id}`,
        severity: 'critical',
        title: `${container.name} is unhealthy`,
        detail: `On ${container.hostname}. Its health check is failing.`,
        icon: 'containers',
        link: ['/containers', container.id],
        since: container.observedAt,
      },
    ];
  }

  if (container.state === 'failed') {
    return [
      {
        id: `container-failed-${container.id}`,
        severity: 'critical',
        title: `${container.name} has failed`,
        detail: `On ${container.hostname}.`,
        icon: 'containers',
        link: ['/containers', container.id],
        since: container.observedAt,
      },
    ];
  }

  if (container.state === 'restarting') {
    return [
      {
        id: `container-restarting-${container.id}`,
        severity: 'warning',
        title: `${container.name} is restarting`,
        detail: `On ${container.hostname}.`,
        icon: 'containers',
        link: ['/containers', container.id],
        since: container.observedAt,
      },
    ];
  }

  return [];
}

function projectIssues(project: ComposeProject): Attention[] {
  if (project.state === 'degraded' || project.state === 'failed') {
    return [
      {
        id: `compose-${project.id}`,
        severity: project.state === 'failed' ? 'critical' : 'warning',
        title: `${project.name} is ${project.state}`,
        detail: `${project.servicesRunning} of ${project.servicesTotal} services running on ${project.hostname}.`,
        icon: 'compose',
        link: ['/compose', project.id],
        since: project.observedAt,
      },
    ];
  }

  return [];
}
