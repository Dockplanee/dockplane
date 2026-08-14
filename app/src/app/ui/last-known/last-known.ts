import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { relativeTime } from '../../core/format';

/**
 * Marks a value as the last one reported rather than the current one.
 *
 * Inventory is kept when a host stops reporting, on purpose: an operator
 * looking into an incident needs to know what was there. What that costs is
 * that every number on the page becomes a claim about the past, and a reading
 * shown the way a live one is shown will be read as live.
 *
 * So this sits beside the value rather than replacing it. Nothing is hidden and
 * nothing is dimmed into illegibility — it says when the value is from, in the
 * quietest way that still registers.
 */
@Component({
  selector: 'dp-last-known',
  template: `
    <span class="mark">Last known</span>
    @if (observedAt(); as at) {
      <span class="age">· reported {{ age(at) }}</span>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: baseline;
      gap: 0.25rem;
      font-size: var(--dp-text-label);
      line-height: 1.4;
      color: var(--dp-fg-muted);
    }

    .mark {
      font-family: var(--font-mono);
      font-size: var(--dp-text-label);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LastKnown {
  /** When the value was observed. Absent when nothing ever reported it. */
  readonly observedAt = input<string | undefined>(undefined);

  protected age(at: string): string {
    return relativeTime(at);
  }
}
