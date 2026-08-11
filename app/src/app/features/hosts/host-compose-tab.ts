import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { Panel } from '../../ui/panel/panel';
import { ComposeTable } from '../shared/compose-table';
import { HostStore } from './host-store';

@Component({
  selector: 'dp-host-compose-tab',
  imports: [ComposeTable, Panel],
  template: `
    <dp-panel flush>
      <dp-compose-table
        [projects]="store.projects()"
        [showHost]="false"
        emptyTitle="No Compose projects on this host"
        emptyDetail="Compose projects appear here once the agent discovers them on this host."
      />
    </dp-panel>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HostComposeTab {
  protected readonly store = inject(HostStore);
}
