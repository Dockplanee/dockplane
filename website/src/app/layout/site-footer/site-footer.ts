import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { buildFooterGroups } from '../../core/navigation';
import { SITE_NAME } from '../../core/site.config';
import { ControlRule } from '../../ui/control-rule/control-rule';
import { Logo } from '../../ui/logo/logo';

@Component({
  selector: 'dp-site-footer',
  templateUrl: './site-footer.html',
  styleUrl: './site-footer.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ControlRule, Logo],
})
export class SiteFooter {
  protected readonly groups = buildFooterGroups();
  protected readonly siteName = SITE_NAME;
}
