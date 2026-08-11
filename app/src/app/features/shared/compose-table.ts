import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { relativeTime } from '../../core/format';
import { ComposeProject } from '../../domain/inventory';
import { composeState } from '../../domain/status';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { TableShell } from '../../ui/table/table-shell';

/** Compose project table, shared by the Compose view and the host detail. */
@Component({
  selector: 'dp-compose-table',
  imports: [RouterLink, EmptyState, StatusBadge, TableShell],
  template: `
    @if (projects().length > 0) {
      <dp-table-shell
        [count]="projects().length"
        [total]="total()"
        noun="project"
        nounPlural="projects"
        minWidth="46rem"
      >
        <table class="dp-table">
          <caption>
            Discovered Docker Compose projects
          </caption>
          <thead>
            <tr>
              <th scope="col">Project</th>
              @if (showHost()) {
                <th scope="col">Host</th>
              }
              <th scope="col">State</th>
              <th scope="col">Services</th>
              <th scope="col">Host</th>
              <th scope="col">Last observed</th>
            </tr>
          </thead>
          <tbody>
            @for (project of projects(); track project.id) {
              <tr>
                <th scope="row">
                  <a class="identifier" [routerLink]="['/compose', project.id]">{{
                    project.name
                  }}</a>
                </th>
                @if (showHost()) {
                  <td class="dp-unknown">{{ project.hostname }}</td>
                }
                <td>
                  <dp-status-badge
                    [tone]="state(project.state).tone"
                    [label]="state(project.state).label"
                  />
                </td>
                <td class="dp-mono">{{ project.servicesRunning }} / {{ project.servicesTotal }}</td>
                <td class="dp-mono dp-unknown">{{ project.hostname }}</td>
                <td class="shrink dp-unknown">
                  {{ project.observedAt ? age(project.observedAt) : '—' }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </dp-table-shell>
    } @else {
      <dp-empty-state icon="compose" [title]="emptyTitle()" [detail]="emptyDetail()" />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposeTable {
  readonly projects = input.required<readonly ComposeProject[]>();
  readonly total = input<number>();
  readonly showHost = input(true);

  readonly emptyTitle = input('No Compose projects found');
  readonly emptyDetail = input(
    'Compose projects appear here once an agent discovers them on a connected host.',
  );

  protected readonly state = composeState;
  protected readonly age = relativeTime;
}
