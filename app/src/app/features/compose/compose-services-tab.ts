import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { Panel } from '../../ui/panel/panel';
import { ContainerPanel } from '../shared/container-panel';
import { ComposeStore } from './compose-store';

@Component({
  selector: 'dp-compose-services-tab',
  imports: [ContainerPanel, Panel],
  template: `
    <dp-panel flush>
      <dp-container-panel
        [containers]="store.containers()"
        [showHost]="false"
        emptyTitle="No services reported"
        emptyDetail="Services appear here once the agent reports the containers belonging to this project."
      />
    </dp-panel>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposeServicesTab {
  protected readonly store = inject(ComposeStore);
}
