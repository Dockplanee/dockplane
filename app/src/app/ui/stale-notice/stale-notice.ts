import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { relativeTime } from '../../core/format';
import { Icon } from '../icon/icon';

/**
 * Marks data that is no longer current.
 *
 * When an agent stops reporting, the interface says so and gives the age of the
 * last report instead of continuing to present old values as live.
 */
@Component({
  selector: 'dp-stale-notice',
  imports: [Icon],
  template: `
    <dp-icon name="alertTriangle" class="glyph" />
    <p>
      {{ reason() }} Values below are from the last report,
      <time [attr.datetime]="lastSeen()">{{ age() }}</time
      >.
    </p>
  `,
  styles: `
    :host {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      padding: 0.625rem 0.75rem;
      border: 1px solid var(--dp-line);
      border-left: 2px solid var(--dp-status-warn);
      border-radius: var(--dp-radius-sm);
      background-color: var(--dp-status-warn-soft);
      color: var(--dp-fg);
      font-size: 0.8125rem;
      line-height: 1.5;
    }

    .glyph {
      margin-top: 0.0625rem;
      width: 1rem;
      height: 1rem;
      color: var(--dp-status-warn);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StaleNotice {
  readonly lastSeen = input.required<string>();
  readonly reason = input('This host is not reporting.');

  protected age(): string {
    return relativeTime(this.lastSeen());
  }
}
