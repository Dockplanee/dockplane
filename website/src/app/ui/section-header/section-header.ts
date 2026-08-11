import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'dp-section-header',
  templateUrl: './section-header.html',
  styleUrl: './section-header.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SectionHeader {
  /** Two-digit position marker that gives the page a schematic reading order. */
  readonly index = input<string>();
  readonly eyebrow = input.required<string>();
  readonly heading = input.required<string>();
  readonly lede = input<string>();

  /** Referenced by the surrounding section through `aria-labelledby`. */
  readonly headingId = input.required<string>();
}
