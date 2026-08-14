import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { timestamp, uptime } from '../../core/format';
import { hostIdentity } from '../../domain/status';
import { Panel } from '../../ui/panel/panel';
import { DetailItem, DetailList } from '../shared/detail-list';
import { ContainerStore } from './container-store';

@Component({
  selector: 'dp-container-overview-tab',
  imports: [DetailList, Panel],
  template: `
    <dp-panel heading="Container" icon="containers">
      <dp-detail-list [items]="details()" />
    </dp-panel>

    <dp-panel heading="Ports" icon="networks" class="stacked">
      @if (ports().length > 0) {
        <ul class="ports">
          @for (port of ports(); track port) {
            <li class="dp-mono">{{ port }}</li>
          }
        </ul>
      } @else {
        <p class="none">No published ports.</p>
      }
    </dp-panel>
  `,
  styles: `
    .stacked {
      margin-top: 0.75rem;
    }

    .ports {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .ports li {
      padding: 0.1875rem 0.5rem;
      border: 1px solid var(--dp-line);
      border-radius: var(--dp-radius-sm);
      background-color: var(--dp-surface-inset);
      font-size: 0.75rem;
    }

    .none {
      color: var(--dp-fg-muted);
      font-size: 0.8125rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContainerOverviewTab {
  protected readonly store = inject(ContainerStore);

  /**
   * What the host reported for this container.
   *
   * The values come from the inspect projection where it has been read, and
   * from the discovery summary otherwise. A field the server does not send is
   * shown as unavailable rather than as an empty string or a zero, which would
   * read as a measurement.
   */
  protected readonly details = computed<readonly DetailItem[]>(() => {
    const container = this.store.container();

    if (!container) {
      return [];
    }

    const detail = this.store.detail();

    const started = detail?.startedAt
      ? uptime(Math.round((Date.now() - new Date(detail.startedAt).getTime()) / 1000))
      : undefined;

    const host = hostIdentity(container.hostName, container.hostname);

    return [
      { label: 'Name', value: container.name, mono: true },
      { label: 'Container ID', value: container.dockerId, mono: true },
      { label: 'Image', value: container.image, mono: true },
      /*
       * The host resource, which is not the same as the machine: several of
       * them can report one system hostname. The hostname follows only where
       * it says something the name does not.
       */
      {
        label: 'Host',
        value: host.primary,
        secondary: host.secondary,
        mono: true,
      },
      { label: 'Restart count', value: String(detail?.restarts ?? container.restarts), mono: true },
      { label: 'Restart policy', value: detail?.restartPolicy ?? '—', mono: true },
      { label: 'Uptime', value: started ?? 'Not running', mono: true },
      {
        label: 'Created',
        value: container.createdAt ? timestamp(detail?.createdAt ?? container.createdAt) : '—',
        mono: true,
      },
      {
        label: 'Finished',
        value: detail?.finishedAt ? timestamp(detail.finishedAt) : '—',
        mono: true,
      },
    ];
  });

  protected readonly ports = computed(() =>
    (this.store.detail()?.ports ?? []).map((port) =>
      port.hostPort
        ? `${port.hostIp ? port.hostIp + ':' : ''}${port.hostPort} → ${port.containerPort}/${port.protocol}`
        : `${port.containerPort}/${port.protocol}`,
    ),
  );
}
