import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { Panel } from '../../ui/panel/panel';
import { DetailList } from '../shared/detail-list';
import { ContainerStore } from './container-store';

/**
 * Container configuration.
 *
 * Environment variables are listed by key only. Values can carry credentials,
 * so they are not delivered to the browser by default.
 */
@Component({
  selector: 'dp-container-configuration-tab',
  imports: [DetailList, Panel],
  template: `
    <dp-panel heading="Runtime" icon="config">
      <dp-detail-list [items]="runtime()" />
    </dp-panel>

    <dp-panel heading="Storage" icon="volumes" class="stacked">
      @if (mounts().length > 0) {
        <ul class="mounts">
          @for (mount of mounts(); track mount) {
            <li class="dp-mono">{{ mount }}</li>
          }
        </ul>
      } @else {
        <p class="none">No mounts are configured for this container.</p>
      }
    </dp-panel>
  `,
  styles: `
    .stacked {
      margin-top: 0.75rem;
    }

    .env,
    .mounts {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.375rem;
    }

    .env li {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.4375rem 0.625rem;
      border: 1px solid var(--dp-line);
      border-radius: var(--dp-radius-sm);
      background-color: var(--dp-surface-inset);
    }

    .key {
      font-size: 0.75rem;
    }

    .value {
      color: var(--dp-fg-muted);
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    .mounts li {
      padding: 0.4375rem 0.625rem;
      border: 1px solid var(--dp-line);
      border-radius: var(--dp-radius-sm);
      background-color: var(--dp-surface-inset);
      font-size: 0.75rem;
      overflow-wrap: anywhere;
    }

    .note {
      margin-top: 0.75rem;
      color: var(--dp-fg-muted);
      font-size: 0.75rem;
      line-height: 1.6;
      max-width: 56ch;
    }

    .none {
      color: var(--dp-fg-muted);
      font-size: 0.8125rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContainerConfigurationTab {
  private readonly store = inject(ContainerStore);

  protected readonly runtime = computed(() => {
    const container = this.store.container();

    if (!container) {
      return [];
    }

    const detail = this.store.detail();
    const limits = detail?.limits;

    return [
      { label: 'Image', value: container.image, mono: true },
      { label: 'Image ID', value: detail?.imageId ?? container.imageId ?? '—', mono: true },
      { label: 'Networks', value: (detail?.networks ?? []).join(', ') || 'None', mono: true },
      { label: 'Restart policy', value: detail?.restartPolicy ?? '—', mono: true },
      { label: 'Restart count', value: String(detail?.restarts ?? container.restarts), mono: true },
      { label: 'Memory limit', value: bytes(limits?.memoryBytes), mono: true },
      { label: 'CPU limit', value: cpus(limits?.nanoCpus), mono: true },
      { label: 'PID limit', value: limits?.pidsLimit ? String(limits.pidsLimit) : '—', mono: true },
    ];
  });

  /**
   * Storage attached to the container.
   *
   * A named volume shows its name. A bind mount shows only that it exists and
   * whether it is writable: the host path never leaves the machine, so there is
   * nothing here to redact.
   */
  protected readonly mounts = computed(() =>
    (this.store.detail()?.mounts ?? []).map((mount) =>
      mount.name
        ? `${mount.name} (${mount.type}${mount.readOnly ? ', read-only' : ''})`
        : `${mount.type}${mount.readOnly ? ' (read-only)' : ''}`,
    ),
  );
}

function bytes(value?: number): string {
  return value && value > 0 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : '—';
}

function cpus(nanoCpus?: number): string {
  return nanoCpus && nanoCpus > 0 ? `${(nanoCpus / 1e9).toFixed(2)} CPU` : '—';
}
