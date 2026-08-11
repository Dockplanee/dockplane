import { Directive, booleanAttribute, input } from '@angular/core';

export type SectionTone = 'canvas' | 'alt';

/**
 * Vertical rhythm and surface tone for a page section. Applied to a native
 * `<section>` so the document keeps its landmark structure.
 */
@Directive({
  selector: 'section[dpSection]',
  host: {
    class: 'dp-section',
    '[class.dp-section--alt]': "tone() === 'alt'",
    '[class.dp-section--divided]': 'divided()',
  },
})
export class Section {
  readonly tone = input<SectionTone>('canvas');

  /** Draws a hairline above the section to separate it from the previous one. */
  readonly divided = input(false, { transform: booleanAttribute });
}
