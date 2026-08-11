import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';

import { externalLink } from '../../core/site.config';
import { PageHero } from '../../ui/page-hero/page-hero';
import { Panel } from '../../ui/panel';
import { Section } from '../../ui/section';
import { CHANGELOG } from './changelog.data';

@Component({
  selector: 'dp-changelog',
  templateUrl: './changelog.html',
  styleUrl: './changelog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, PageHero, Panel, Section],
})
export class Changelog {
  protected readonly releases = CHANGELOG;
  protected readonly releasesUrl = externalLink('releases');
}
