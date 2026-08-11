import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { timestamp } from '../../core/format';
import { Panel } from '../../ui/panel/panel';
import { DetailItem, DetailList } from '../shared/detail-list';
import { ContainerPanel } from '../shared/container-panel';
import { ComposeStore } from './compose-store';

@Component({
  selector: 'dp-compose-overview-tab',
  imports: [ContainerPanel, DetailList, Panel],
  template: `
    <dp-panel heading="Summary" icon="compose">
      <dp-detail-list [items]="summary()" />
    </dp-panel>

    <dp-panel heading="Services" icon="containers" class="stacked" flush>
      <dp-container-panel
        [containers]="store.containers()"
        [showHost]="false"
        emptyTitle="No containers reported"
        emptyDetail="Containers appear here once the agent reports the workloads belonging to this project."
      />
    </dp-panel>
  `,
  styles: `
    .stacked {
      margin-top: 0.75rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposeOverviewTab {
  protected readonly store = inject(ComposeStore);

  protected readonly summary = computed<readonly DetailItem[]>(() => {
    const project = this.store.project();

    if (!project) {
      return [];
    }

    /*
     * Compose records a working directory and config file paths; the server
     * deliberately does not send them, because they describe the host's
     * filesystem and a read-only view has no use for them.
     */
    return [
      { label: 'Project', value: project.name, mono: true },
      { label: 'Host', value: project.hostname, mono: true },
      {
        label: 'Services',
        value: `${project.servicesRunning} of ${project.servicesTotal} running`,
      },
      { label: 'Containers', value: String(this.store.containers().length), mono: true },
      {
        label: 'Last observed',
        value: project.observedAt ? timestamp(project.observedAt) : '—',
        mono: true,
      },
    ];
  });
}
