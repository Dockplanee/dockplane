import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Compact figure with a label and supporting context. */
@Component({
  selector: 'dp-metric-tile',
  templateUrl: './metric-tile.html',
  styleUrl: './metric-tile.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MetricTile {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly detail = input<string>();
}
