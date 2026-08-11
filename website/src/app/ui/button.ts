import { Directive, input } from '@angular/core';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'md' | 'lg';

/** Applies the shared action styling to a native button or link. */
@Directive({
  selector: 'a[dpButton], button[dpButton]',
  host: {
    class: 'dp-button',
    '[class.dp-button--primary]': "variant() === 'primary'",
    '[class.dp-button--secondary]': "variant() === 'secondary'",
    '[class.dp-button--ghost]': "variant() === 'ghost'",
    '[class.dp-button--lg]': "size() === 'lg'",
  },
})
export class Button {
  readonly variant = input<ButtonVariant>('secondary');
  readonly size = input<ButtonSize>('md');
}
