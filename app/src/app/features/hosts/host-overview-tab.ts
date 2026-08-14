import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { timestamp, uptime } from '../../core/format';
import { LastKnown } from '../../ui/last-known/last-known';
import { Meter } from '../../ui/meter/meter';
import { Panel } from '../../ui/panel/panel';
import { DetailItem, DetailList } from '../shared/detail-list';
import { HostStore } from './host-store';

@Component({
  selector: 'dp-host-overview-tab',
  imports: [DetailList, LastKnown, Meter, Panel],
  template: `
    <div class="split">
      <dp-panel heading="Resources" icon="metrics">
        <!--
          A host that has stopped reporting keeps its last readings. Withholding
          them was the wrong instinct: the moment somebody most wants to know
          what a machine was doing is after it went quiet. They are shown as
          what they are — the last observation, dated, without the live colour.
        -->
        @if (hasReadings()) {
          <dl class="resources">
            @for (resource of resources(); track resource.label) {
              <div>
                <dt class="dp-label">{{ resource.label }}</dt>
                <dd>
                  <dp-meter
                    [percent]="resource.percent"
                    [label]="resource.label + ' ' + (resource.detail || resource.percent + '%')"
                    [muted]="!store.reporting()"
                  />
                  @if (resource.detail) {
                    <span class="resource-detail">{{ resource.detail }}</span>
                  }
                  @if (!store.reporting()) {
                    <dp-last-known [observedAt]="observedAt()" />
                  }
                </dd>
              </div>
            }
          </dl>
        } @else {
          <p class="offline">This host has never reported its resources.</p>
        }
      </dp-panel>

      <dp-panel heading="Workloads" icon="containers">
        <dl class="counts">
          @for (count of counts(); track count.label) {
            <div>
              <dt class="dp-label">{{ count.label }}</dt>
              <dd>
                {{ count.value }}
                @if (!store.reporting()) {
                  <dp-last-known [observedAt]="observedAt()" />
                }
              </dd>
            </div>
          }
        </dl>
      </dp-panel>
    </div>

    <dp-panel heading="Host" icon="hosts" class="stacked">
      <dp-detail-list [items]="details()" />
    </dp-panel>
  `,
  styles: `
    .split {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.75rem;
    }

    .stacked {
      margin-top: 0.75rem;
    }

    .resources {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.875rem;
    }

    .resources dd {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-top: 0.375rem;
    }

    .resource-detail {
      color: var(--dp-fg-muted);
      font-size: 0.75rem;
    }

    .offline {
      color: var(--dp-fg-muted);
      font-size: 0.8125rem;
    }

    .counts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(6rem, 1fr));
      gap: 0.875rem;
    }

    .counts dd {
      margin-top: 0.25rem;
      font-size: 1.25rem;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }

    @media (min-width: 900px) {
      .split {
        grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HostOverviewTab {
  protected readonly store = inject(HostStore);

  /** Whether there is anything to show, current or not. */
  protected readonly hasReadings = computed(() => this.resources().length > 0);

  /** When the readings on screen were taken. */
  protected readonly observedAt = computed(
    () => this.store.host()?.observedAt ?? this.store.host()?.lastSeen,
  );

  protected readonly resources = computed(() => {
    const host = this.store.host();

    if (!host) {
      return [];
    }

    /*
     * A reading is shown when there is one. The absolute figure beside it is
     * not always there — CPU is reported as a percentage and nothing else —
     * and requiring it meant the panel silently dropped CPU on every host and
     * stood empty on hosts that report only that.
     */
    return [
      { label: 'CPU', usage: host.cpu },
      { label: 'Memory', usage: host.memory },
      { label: 'Disk', usage: host.disk },
    ]
      .filter((resource) => resource.usage !== undefined)
      .map((resource) => ({
        label: resource.label,
        percent: resource.usage!.percent,
        detail: resource.usage!.detail ?? '',
      }));
  });

  protected readonly counts = computed(() => {
    const counts = this.store.counts();

    return [
      { label: 'Total', value: counts.total },
      { label: 'Running', value: counts.running },
      { label: 'Stopped', value: counts.stopped },
      { label: 'Restarting', value: counts.restarting },
      { label: 'Unhealthy', value: counts.unhealthy },
    ];
  });

  protected readonly details = computed<readonly DetailItem[]>(() => {
    const host = this.store.host();

    if (!host) {
      return [];
    }

    // A field the host has not reported reads as unavailable. An empty string
    // would look like a value, and a zero would look like a measurement.
    return [
      { label: 'Host', value: host.name, mono: true },
      { label: 'Operating system', value: host.os ?? '—' },
      { label: 'Architecture', value: host.architecture ?? '—', mono: true },
      { label: 'Kernel', value: host.kernel ?? '—', mono: true },
      { label: 'Docker Engine', value: host.dockerVersion ?? '—', mono: true },
      { label: 'Agent ID', value: host.agentId ?? '—', mono: true },
      { label: 'Agent version', value: host.agentVersion ?? '—', mono: true },
      { label: 'Uptime', value: uptime(host.uptimeSeconds) ?? '—', mono: true },
      { label: 'Last seen', value: host.lastSeen ? timestamp(host.lastSeen) : '—', mono: true },
      {
        label: 'Last observed',
        value: host.observedAt ? timestamp(host.observedAt) : '—',
        mono: true,
      },
    ];
  });
}
