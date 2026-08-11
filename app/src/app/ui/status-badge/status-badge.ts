import { ChangeDetectionStrategy, Component, booleanAttribute, input } from '@angular/core';

import { StatusTone } from '../../domain/status';

/**
 * Operational state indicator.
 *
 * Every tone carries a distinct glyph shape, so state survives greyscale and
 * colour-blind viewing. The label is always rendered.
 */
@Component({
  selector: 'dp-status-badge',
  template: `
    <span class="glyph" aria-hidden="true"></span>
    <span class="label">{{ label() }}</span>
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: 0.4375rem;
      font-size: 0.8125rem;
      font-weight: 500;
      line-height: 1.2;
      white-space: nowrap;
    }

    :host(.plated) {
      padding: 0.1875rem 0.5rem;
      border-radius: var(--dp-radius-sm);
      font-size: 0.75rem;
    }

    .glyph {
      width: 0.5rem;
      height: 0.5rem;
      flex: none;
      background-color: currentcolor;
    }

    :host(.tone-ok) {
      color: var(--dp-status-ok);
    }

    :host(.tone-ok) .glyph {
      border-radius: 50%;
    }

    :host(.tone-ok.plated) {
      background-color: var(--dp-status-ok-soft);
    }

    :host(.tone-warn) {
      color: var(--dp-status-warn);
    }

    :host(.tone-warn) .glyph {
      width: 0.5625rem;
      clip-path: polygon(50% 0%, 100% 100%, 0% 100%);
    }

    :host(.tone-warn.plated) {
      background-color: var(--dp-status-warn-soft);
    }

    :host(.tone-critical) {
      color: var(--dp-status-critical);
    }

    :host(.tone-critical) .glyph {
      border-radius: 1px;
    }

    :host(.tone-critical.plated) {
      background-color: var(--dp-status-critical-soft);
    }

    :host(.tone-info) {
      color: var(--dp-status-info);
    }

    :host(.tone-info) .glyph {
      transform: rotate(45deg);
      border-radius: 1px;
    }

    :host(.tone-info.plated) {
      background-color: var(--dp-status-info-soft);
    }

    :host(.tone-neutral) {
      color: var(--dp-status-neutral);
    }

    :host(.tone-neutral) .glyph {
      background-color: transparent;
      border: 1.5px solid currentcolor;
      border-radius: 50%;
    }

    :host(.tone-neutral.plated) {
      background-color: var(--dp-status-neutral-soft);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': "'tone-' + tone()",
    '[class.plated]': 'plated()',
  },
})
export class StatusBadge {
  readonly tone = input.required<StatusTone>();
  readonly label = input.required<string>();

  /** Adds a tinted plate, used where the badge must stand out inside a table. */
  readonly plated = input(false, { transform: booleanAttribute });
}
