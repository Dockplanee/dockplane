import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { EmptyState } from '../../ui/empty-state/empty-state';
import { Panel } from '../../ui/panel/panel';
import { ContainerStore } from './container-store';

/**
 * The networks this container is attached to.
 *
 * Names only. The server does not send network drivers, scopes or address
 * assignments, and there is no networks endpoint to ask, so this reports what
 * the inspect projection carries and nothing more.
 */
@Component({
  selector: 'dp-container-networks-tab',
  imports: [EmptyState, Panel],
  template: `
    <dp-panel heading="Networks" icon="networks" headingId="networks-heading">
      @if (store.networks().length > 0) {
        <ul class="list">
          @for (network of store.networks(); track network) {
            <li class="dp-mono">{{ network }}</li>
          }
        </ul>
      } @else {
        <dp-empty-state
          icon="networks"
          title="No network reported"
          [detail]="
            store.unavailable()
              ? 'The host has not been reachable, so no detail has been read for this container.'
              : 'This container is not attached to a named network.'
          "
        />
      }
    </dp-panel>
  `,
  styles: `
    .list {
      display: grid;
      gap: 0.5rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContainerNetworksTab {
  protected readonly store = inject(ContainerStore);
}
