import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';

import { relativeTime } from '../../core/format';
import { PageContext } from '../../core/page-context';
import { DockplaneApi } from '../../data/dockplane-api';
import { ComposeProject, Container, Host } from '../../domain/inventory';
import { SEVERITY_ORDER, severity, Severity } from '../../domain/status';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { Icon, IconName } from '../../ui/icon/icon';
import { Panel } from '../../ui/panel/panel';
import { SelectFilter } from '../../ui/select-filter/select-filter';
import { StatusBadge } from '../../ui/status-badge/status-badge';

const KIND_ICONS: Record<string, IconName> = {
  host: 'hosts',
  container: 'containers',
  compose: 'compose',
  agent: 'agents',
  image: 'images',
};

/**
 * Problem view.
 *
 * Health prioritises what is wrong rather than visualising overall state; the
 * overview already carries the summary figures.
 */
@Component({
  selector: 'dp-health',
  imports: [RouterLink, EmptyState, Icon, Panel, SelectFilter, StatusBadge],
  template: `
    <dp-panel flush>
      <div class="dp-controls">
        <dp-select-filter
          id="health-severity"
          label="Filter by severity"
          [options]="severityOptions"
          [value]="severityFilter()"
          (valueChange)="severityFilter.set($event)"
        />
        <div class="dp-controls__spacer"></div>
      </div>

      @if (issues().length > 0) {
        <ul class="issues">
          @for (issue of issues(); track issue.id) {
            <li>
              <a class="issue" [routerLink]="issue.link">
                <span class="glyph" [class]="'tone-' + level(issue.severity).tone">
                  <dp-icon [name]="icon(issue.kind)" />
                </span>

                <span class="body">
                  <span class="title">{{ issue.title }}</span>
                  <span class="detail">{{ issue.detail }}</span>
                </span>

                <span class="meta">
                  <dp-status-badge
                    [tone]="level(issue.severity).tone"
                    [label]="level(issue.severity).label"
                    plated
                  />
                  <span class="resource dp-mono">{{ issue.resource }}</span>
                  @if (issue.since) {
                    <span class="since">{{ age(issue.since) }}</span>
                  }
                </span>

                <dp-icon name="chevronRight" class="chevron" />
              </a>
            </li>
          }
        </ul>
      } @else {
        <dp-empty-state
          icon="check"
          title="Nothing needs attention"
          detail="No host, workload or agent is currently reporting a problem."
        />
      }
    </dp-panel>
  `,
  styles: `
    .issues {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .issues li + li {
      border-top: 1px solid var(--dp-line);
    }

    .issue {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.875rem 1rem;
      color: inherit;
      text-decoration: none;
    }

    .issue:hover {
      background-color: var(--dp-surface-alt);
    }

    .glyph {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2rem;
      height: 2rem;
      flex: none;
      border-radius: var(--dp-radius-sm);
      background-color: var(--dp-surface-inset);
      color: var(--dp-fg-muted);
    }

    .glyph.tone-critical {
      background-color: var(--dp-status-critical-soft);
      color: var(--dp-status-critical);
    }

    .glyph.tone-warn {
      background-color: var(--dp-status-warn-soft);
      color: var(--dp-status-warn);
    }

    .glyph.tone-info {
      background-color: var(--dp-status-info-soft);
      color: var(--dp-status-info);
    }

    .body {
      flex: 1;
      min-width: 0;
    }

    .title {
      display: block;
      font-size: 0.875rem;
      font-weight: 550;
    }

    .detail {
      display: block;
      margin-top: 0.125rem;
      color: var(--dp-fg-muted);
      font-size: 0.75rem;
    }

    .meta {
      display: flex;
      align-items: center;
      gap: 0.875rem;
      flex: none;
    }

    .resource,
    .since {
      display: none;
      color: var(--dp-fg-muted);
      font-size: 0.75rem;
    }

    .chevron {
      width: 1rem;
      height: 1rem;
      flex: none;
      color: var(--dp-fg-muted);
    }

    @media (min-width: 768px) {
      .resource,
      .since {
        display: inline;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Health {
  private readonly api = inject(DockplaneApi);

  protected readonly severityFilter = signal('all');

  protected readonly severityOptions = [
    { value: 'all', label: 'All severities' },
    { value: 'critical', label: 'Critical' },
    { value: 'warning', label: 'Warning' },
    { value: 'info', label: 'Info' },
  ];

  private readonly hosts = toSignal(this.api.hosts(), { initialValue: [] });
  private readonly containers = toSignal(this.api.containers(), { initialValue: [] });
  private readonly projects = toSignal(this.api.composeProjects(), { initialValue: [] });

  /**
   * Problems read off the state the control server already reports.
   *
   * There is no monitoring engine behind this page and no health endpoint: a
   * problem here is a host whose agent is gone, a record nothing is refreshing,
   * a container failing its own health check or exited, or a Compose project
   * not fully up. Nothing is inferred from a threshold the product never set.
   */
  private readonly all = computed<readonly HealthIssue[]>(() => [
    ...this.hosts().flatMap(hostIssues),
    ...this.containers().flatMap(containerIssues),
    ...this.projects().flatMap(projectIssues),
  ]);

  protected readonly issues = computed(() => {
    const filter = this.severityFilter();

    return [...this.all()]
      .filter((issue) => filter === 'all' || issue.severity === filter)
      .sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.title.localeCompare(b.title),
      );
  });

  protected readonly level = severity;
  protected readonly age = relativeTime;

  protected icon(kind: string): IconName {
    return KIND_ICONS[kind] ?? 'info';
  }

  constructor() {
    inject(PageContext).set({
      title: 'Health',
      subtitle: 'Workloads, hosts and agents that need attention',
    });
  }
}

/** What the page shows. Every field comes from a record the server returned. */
interface HealthIssue {
  readonly id: string;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  readonly kind: 'host' | 'container' | 'compose';
  readonly resource: string;
  readonly link: readonly string[];
  readonly since?: string;
}

function hostIssues(host: Host): HealthIssue[] {
  if (host.status === 'offline') {
    return [
      {
        id: `host-offline-${host.id}`,
        severity: 'critical',
        title: `${host.name} is offline`,
        detail: 'The agent is not connected, so nothing on this host is being refreshed.',
        kind: 'host',
        resource: host.name,
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
        kind: 'host',
        resource: host.name,
        link: ['/hosts', host.id],
        since: host.observedAt,
      },
    ];
  }

  return [];
}

function containerIssues(container: Container): HealthIssue[] {
  const base = {
    kind: 'container' as const,
    resource: container.name,
    link: ['/containers', container.id],
    since: container.observedAt,
  };

  if (container.health === 'unhealthy') {
    return [
      {
        ...base,
        id: `container-unhealthy-${container.id}`,
        severity: 'critical',
        title: `${container.name} is unhealthy`,
        detail: `Its health check is failing on ${container.hostname}.`,
      },
    ];
  }

  if (container.state === 'failed') {
    return [
      {
        ...base,
        id: `container-failed-${container.id}`,
        severity: 'critical',
        title: `${container.name} has failed`,
        detail: `On ${container.hostname}.`,
      },
    ];
  }

  if (container.state === 'restarting') {
    return [
      {
        ...base,
        id: `container-restarting-${container.id}`,
        severity: 'warning',
        title: `${container.name} is restarting`,
        detail: `On ${container.hostname}.`,
      },
    ];
  }

  return [];
}

function projectIssues(project: ComposeProject): HealthIssue[] {
  if (project.state !== 'degraded' && project.state !== 'failed') {
    return [];
  }

  return [
    {
      id: `compose-${project.id}`,
      severity: project.state === 'failed' ? 'critical' : 'warning',
      title: `${project.name} is ${project.state}`,
      detail: `${project.servicesRunning} of ${project.servicesTotal} services running on ${project.hostname}.`,
      kind: 'compose',
      resource: project.name,
      link: ['/compose', project.id],
      since: project.observedAt,
    },
  ];
}
