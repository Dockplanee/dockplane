import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { ContainerManagement } from '../../domain/inventory';
import { StatusBadge } from '../../ui/status-badge/status-badge';

/**
 * Who decides what this container is.
 *
 * Shown because the answer changes what an operator may do, and because being
 * told afterwards is worse than being told first: a container Dockplane merely
 * found offers no way to change it, and an operator who did not know that would
 * read the absence of a button as a fault.
 *
 * Two states outrank the rest and are shown instead. A container in conflict or
 * mid-change cannot be operated at all, which matters more than where its
 * configuration comes from.
 */
@Component({
  selector: 'dp-management-badge',
  imports: [StatusBadge],
  template: ` <dp-status-badge class="plated" [tone]="badge().tone" [label]="badge().label" /> `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ManagementBadge {
  readonly management = input.required<ContainerManagement>();

  protected readonly badge = computed(() => {
    const management = this.management();

    if (management.identityConflict) {
      return { tone: 'critical' as const, label: 'Conflict' };
    }

    if (management.reconciling) {
      return { tone: 'warn' as const, label: 'Reconciling' };
    }

    switch (management.kind) {
      case 'managed':
        return { tone: 'ok' as const, label: 'Managed' };
      case 'stack':
        return { tone: 'info' as const, label: 'Stack' };
      default:
        return { tone: 'neutral' as const, label: 'External' };
    }
  });
}
