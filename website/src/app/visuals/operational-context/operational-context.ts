import { ChangeDetectionStrategy, Component } from '@angular/core';

import { MetricTile } from '../../ui/metric-tile/metric-tile';
import { AppFrame } from '../app-frame/app-frame';
import { PREVIEW_CONTAINER_METRICS, PREVIEW_EVENTS, PREVIEW_LOG_LINES } from '../preview-data';

@Component({
  selector: 'dp-operational-context',
  templateUrl: './operational-context.html',
  styleUrl: './operational-context.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppFrame, MetricTile],
})
export class OperationalContext {
  protected readonly metrics = PREVIEW_CONTAINER_METRICS;
  protected readonly logLines = PREVIEW_LOG_LINES;
  protected readonly events = PREVIEW_EVENTS;
}
