import { ChangeDetectionStrategy, Component } from '@angular/core';

import { MetricTile } from '../../ui/metric-tile/metric-tile';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { AppFrame } from '../app-frame/app-frame';
import { PREVIEW_ATTENTION, PREVIEW_HOSTS, PREVIEW_SUMMARY } from '../preview-data';

@Component({
  selector: 'dp-overview-preview',
  templateUrl: './overview-preview.html',
  styleUrl: './overview-preview.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppFrame, MetricTile, StatusBadge],
})
export class OverviewPreview {
  protected readonly summary = PREVIEW_SUMMARY;
  protected readonly hosts = PREVIEW_HOSTS;
  protected readonly attention = PREVIEW_ATTENTION;
}
