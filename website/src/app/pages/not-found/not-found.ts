import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { PRIMARY_NAV } from '../../core/navigation';
import { Button } from '../../ui/button';
import { ControlRule } from '../../ui/control-rule/control-rule';

@Component({
  selector: 'dp-not-found',
  templateUrl: './not-found.html',
  styleUrl: './not-found.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Button, ControlRule],
})
export class NotFound {
  protected readonly navigation = PRIMARY_NAV;
}
