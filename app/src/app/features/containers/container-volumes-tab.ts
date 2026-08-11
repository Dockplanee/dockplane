import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { EmptyState } from '../../ui/empty-state/empty-state';
import { Panel } from '../../ui/panel/panel';
import { ContainerStore } from './container-store';

/**
 * Storage attached to this container.
 *
 * A named volume is listed by name. A bind mount is listed as a bind mount and
 * nothing else: its source is a path on the host, which never leaves the
 * machine, so there is nothing here to redact.
 */
@Component({
  selector: 'dp-container-volumes-tab',
  imports: [EmptyState, Panel],
  template: `
    <dp-panel heading="Storage" icon="volumes" headingId="volumes-heading">
      @if (mounts().length > 0) {
        <ul class="list">
          @for (mount of mounts(); track mount.label) {
            <li>
              <span class="dp-mono">{{ mount.label }}</span>
              <span class="secondary">{{ mount.detail }}</span>
            </li>
          }
        </ul>
      } @else {
        <dp-empty-state
          icon="volumes"
          title="No storage reported"
          [detail]="
            store.unavailable()
              ? 'The host has not been reachable, so no detail has been read for this container.'
              : 'This container has no volumes or bind mounts.'
          "
        />
      }
    </dp-panel>
  `,
  styles: `
    .list {
      display: grid;
      gap: 0.625rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .secondary {
      display: block;
      color: var(--dp-fg-muted);
      font-size: var(--dp-text-label);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContainerVolumesTab {
  protected readonly store = inject(ContainerStore);

  protected readonly mounts = computed(() =>
    this.store.mounts().map((mount) => ({
      label: mount.name ?? `${mount.type} mount`,
      detail: `${mount.type}${mount.readOnly ? ', read-only' : ', writable'}`,
    })),
  );
}
