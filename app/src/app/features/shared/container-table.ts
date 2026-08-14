import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';

import { relativeTime, uptime } from '../../core/format';
import { Permission, Permissions } from '../../core/permissions';
import { Container } from '../../domain/inventory';
import { containerHealth, containerState } from '../../domain/status';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { RowAction, RowMenu } from '../../ui/row-menu/row-menu';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { TableShell } from '../../ui/table/table-shell';
import { ManagementBadge } from './management-badge';

type Lifecycle = 'start' | 'stop' | 'restart';

export interface ContainerActionRequest {
  readonly container: Container;
  readonly action: Lifecycle;
}

const PERMISSION: Record<Lifecycle, Permission> = {
  start: 'containers.start',
  stop: 'containers.stop',
  restart: 'containers.restart',
};

/**
 * Container table shared by the container list, the host detail and Compose.
 *
 * Lifecycle entries are offered according to the current state and the
 * operator's permissions; the control server still authorizes each request.
 */
@Component({
  selector: 'dp-container-table',
  imports: [RouterLink, EmptyState, ManagementBadge, RowMenu, StatusBadge, TableShell],
  templateUrl: './container-table.html',
  styles: `
    .secondary {
      display: block;
      color: var(--dp-fg-muted);
      font-size: var(--dp-text-label);
      line-height: 1.4;
    }

    .last-known {
      display: block;
      margin-top: 0.125rem;
      font-size: 0.6875rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContainerTable {
  private readonly permissions = inject(Permissions);

  readonly containers = input.required<readonly Container[]>();
  readonly total = input<number>();

  /** Hides the host column where every row belongs to the same host. */
  readonly showHost = input(true);

  readonly emptyTitle = input('No containers found');
  readonly emptyDetail = input('No container matches the current search and filters.');

  readonly actionRequested = output<ContainerActionRequest>();

  protected readonly state = containerState;
  protected readonly health = containerHealth;
  protected readonly age = relativeTime;

  protected readonly minWidth = computed(() => (this.showHost() ? '74rem' : '66rem'));

  /**
   * The lifecycle entries for one row.
   *
   * An entry is enabled only where it could succeed: the operator holds the
   * permission, the container is in a state the operation applies to, and the
   * record is being refreshed — a stale row means the host stopped reporting,
   * and the control server would refuse the request anyway.
   */
  protected actionsFor(container: Container): readonly RowAction[] {
    const running = container.state === 'running' || container.state === 'restarting';

    return [
      this.action('start', 'Start container', !running, container),
      this.action('stop', 'Stop container', running, container),
      this.action('restart', 'Restart container', running, container),
    ];
  }

  private action(id: Lifecycle, label: string, applies: boolean, container: Container): RowAction {
    const permission = PERMISSION[id];
    const granted = this.permissions.has(permission);

    /*
     * A container nobody can identify, or one whose last change has not been
     * settled, cannot be operated at all. The control server refuses these too;
     * saying so here means an operator learns why before clicking rather than
     * from a refusal afterwards.
     */
    const undetermined = container.management.identityConflict
      ? 'More than one Docker container claims this one, so nothing may be done to it.'
      : container.management.reconciling
        ? 'A change to this container has not been settled yet.'
        : undefined;

    return {
      id,
      label,
      disabled: !granted || !applies || container.stale || Boolean(undetermined),
      hint: !granted
        ? `Requires the ${permission} permission.`
        : (undetermined ??
          (!applies
            ? id === 'start'
              ? 'The container is already running.'
              : 'The container is not running.'
            : container.stale
              ? 'The host is not reporting, so nothing can be carried out on it now.'
              : undefined)),
    };
  }

  protected onAction(container: Container, action: string): void {
    if (action === 'start' || action === 'stop' || action === 'restart') {
      this.actionRequested.emit({ container, action });
    }
  }

  /**
   * How long the container has existed.
   *
   * Discovery reports when Docker created it; when it was last started is part
   * of the inspect projection, which the list does not read. Showing the age of
   * a stopped container would be misleading, so it shows nothing.
   */
  /** When the host last said anything about this container. */
  protected reportedAt(container: Container): string {
    return container.observedAt
      ? `Reported ${relativeTime(container.observedAt)}`
      : 'Never reported';
  }

  protected runningFor(container: Container): string {
    if (!container.createdAt || container.state !== 'running') {
      return '—';
    }

    const seconds = Math.round((Date.now() - new Date(container.createdAt).getTime()) / 1000);

    return uptime(seconds) ?? '—';
  }
}
