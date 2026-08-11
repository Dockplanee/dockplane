import { ChangeDetectionStrategy, Component } from '@angular/core';

import { StatusBadge } from '../../ui/status-badge/status-badge';
import { AppFrame } from '../app-frame/app-frame';
import { PREVIEW_HOSTS } from '../preview-data';

@Component({
  selector: 'dp-host-fleet',
  templateUrl: './host-fleet.html',
  styleUrl: './host-fleet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppFrame, StatusBadge],
})
export class HostFleet {
  protected readonly hosts = PREVIEW_HOSTS;
}
