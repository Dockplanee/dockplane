import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Titled supporting point. Body copy is projected so it can carry inline markup. */
@Component({
  selector: 'dp-feature',
  templateUrl: './feature.html',
  styleUrl: './feature.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Feature {
  readonly title = input.required<string>();
}
