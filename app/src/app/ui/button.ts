import { Directive, booleanAttribute, input } from '@angular/core';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/**
 * Shared action styling for native buttons and links.
 *
 * `danger` is reserved for destructive operations and never doubles as the
 * primary style, so a mint button is always a safe action.
 */
@Directive({
  selector: 'a[dpButton], button[dpButton]',
  host: {
    class: 'dp-button',
    '[class.dp-button--primary]': "variant() === 'primary'",
    '[class.dp-button--secondary]': "variant() === 'secondary'",
    '[class.dp-button--ghost]': "variant() === 'ghost'",
    '[class.dp-button--danger]': "variant() === 'danger'",
    '[class.dp-button--icon]': 'iconOnly()',
  },
})
export class Button {
  readonly variant = input<ButtonVariant>('secondary');

  /** Square control. The caller must still supply an accessible name. */
  readonly iconOnly = input(false, { transform: booleanAttribute });
}
