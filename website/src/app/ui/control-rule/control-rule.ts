import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Hairline with mint endpoints. Repeats the control-line geometry of the brand
 * mark as a structural divider; it is decorative and exposes no semantics.
 */
@Component({
  selector: 'dp-control-rule',
  templateUrl: './control-rule.html',
  styleUrl: './control-rule.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true',
  },
})
export class ControlRule {
  /** Optional monospace caption placed on the line. */
  readonly label = input<string>();
}
