import { ChangeDetectionStrategy, Component } from '@angular/core';

import { StatusBadge } from '../../ui/status-badge/status-badge';
import { AppFrame } from '../app-frame/app-frame';
import { PREVIEW_COMPOSE } from '../preview-data';

@Component({
  selector: 'dp-compose-project',
  templateUrl: './compose-project.html',
  styleUrl: './compose-project.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppFrame, StatusBadge],
})
export class ComposeProject {
  protected readonly project = PREVIEW_COMPOSE;
}
