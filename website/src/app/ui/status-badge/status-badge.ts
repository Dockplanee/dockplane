import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type StatusTone = 'ok' | 'warn' | 'critical' | 'info' | 'neutral';

/**
 * Operational state indicator. Each tone carries a distinct glyph shape so the
 * state is never communicated through colour alone.
 */
@Component({
  selector: 'dp-status-badge',
  templateUrl: './status-badge.html',
  styleUrl: './status-badge.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': "'badge badge--' + tone()",
  },
})
export class StatusBadge {
  readonly tone = input.required<StatusTone>();
  readonly label = input.required<string>();
}
