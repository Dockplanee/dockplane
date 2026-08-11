import { Directive, input } from '@angular/core';

export type PanelTone = 'surface' | 'inset';

/** Bordered container used to group related content without decorative depth. */
@Directive({
  selector: '[dpPanel]',
  host: {
    class: 'dp-panel',
    '[class.dp-panel--inset]': "tone() === 'inset'",
  },
})
export class Panel {
  readonly tone = input<PanelTone>('surface');
}
