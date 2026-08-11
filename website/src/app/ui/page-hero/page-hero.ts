import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Introductory block shared by the secondary pages. */
@Component({
  selector: 'dp-page-hero',
  templateUrl: './page-hero.html',
  styleUrl: './page-hero.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PageHero {
  readonly eyebrow = input.required<string>();
  readonly heading = input.required<string>();
  readonly lede = input<string>();
  readonly headingId = input('page-heading');
}
