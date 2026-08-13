import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ContainerState, containerState } from '../../domain/status';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { Panel } from '../../ui/panel/panel';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { TableShell } from '../../ui/table/table-shell';
import { StackStore } from './stack-store';

/** The states this product names. Anything else is reported as a failure. */
const KNOWN_STATES = new Set<string>([
  'running',
  'stopped',
  'starting',
  'stopping',
  'restarting',
  'failed',
]);

/**
 * The services of a stack, and the containers behind them.
 *
 * A service is identified by its name and by the Dockplane container it is —
 * both of which survive a revision being applied. The Docker container changes
 * every time, which is why it is not what anything links to.
 */
@Component({
  selector: 'dp-stack-services-tab',
  imports: [RouterLink, EmptyState, Panel, StatusBadge, TableShell],
  template: `
    <dp-panel flush>
      @if (services().length > 0) {
        <dp-table-shell
          [count]="services().length"
          [total]="services().length"
          noun="service"
          nounPlural="services"
          minWidth="46rem"
        >
          <table class="dp-table">
            <caption>
              Services of this stack
            </caption>
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Container</th>
                <th scope="col">State</th>
                <th scope="col">Image</th>
                <th scope="col">Revision</th>
              </tr>
            </thead>
            <tbody>
              @for (service of services(); track service.containerId) {
                <tr>
                  <th scope="row" class="dp-mono">{{ service.serviceName }}</th>
                  <td>
                    <a class="identifier" [routerLink]="['/containers', service.containerId]">{{
                      service.name
                    }}</a>
                  </td>
                  <td>
                    <dp-status-badge
                      [tone]="state(service.state).tone"
                      [label]="state(service.state).label"
                    />
                  </td>
                  <td class="dp-mono">{{ service.image }}</td>
                  <td class="dp-mono">{{ revisionOf(service.revisionId) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </dp-table-shell>
      } @else {
        <dp-empty-state
          icon="containers"
          title="No services"
          detail="Nothing of this stack is on its host yet."
        />
      }
    </dp-panel>

    <p class="note">
      A service's configuration comes from the stack. Its container cannot be edited or removed on
      its own; apply a revision instead.
    </p>
  `,
  styles: `
    :host {
      display: block;
    }

    .identifier {
      font-family: var(--font-mono);
    }

    .note {
      margin: 0.875rem 0 0;
      color: var(--dp-fg-muted);
      font-size: 0.8125rem;
      max-width: 78ch;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StackServicesTab {
  private readonly store = inject(StackStore);

  protected readonly services = computed(() => this.store.services());

  /**
   * The state a container reports, as the interface words it.
   *
   * The server sends whatever Docker said, so an unfamiliar word is shown as
   * unknown rather than being forced into one of the five this product names.
   */
  protected state(value: string) {
    return containerState(KNOWN_STATES.has(value) ? (value as ContainerState) : 'failed');
  }

  /** Which revision a container says it is, in the numbers an operator reads. */
  protected revisionOf(revisionId: string | null): string {
    if (!revisionId) {
      return '—';
    }

    const revision = this.store.revisions().find((entry) => entry.id === revisionId);

    return revision ? `#${revision.number}` : 'Unknown';
  }
}
