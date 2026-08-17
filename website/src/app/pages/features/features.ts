import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { GET_STARTED } from '../../core/navigation';
import { Button } from '../../ui/button';
import { ControlRule } from '../../ui/control-rule/control-rule';
import { PageHero } from '../../ui/page-hero/page-hero';
import { Panel } from '../../ui/panel';
import { Section } from '../../ui/section';
import { SectionHeader } from '../../ui/section-header/section-header';
import { FEATURE_AREAS, OUT_OF_SCOPE, PLANNED } from './feature-catalog';

/**
 * The index a section carries after the capability areas.
 *
 * Derived rather than written down. The two sections below the areas were
 * numbered by hand, and adding areas to the catalogue silently made them
 * repeat numbers the areas already used.
 */
function indexAfterAreas(offset: number): string {
  return String(FEATURE_AREAS.length + offset).padStart(2, '0');
}

@Component({
  selector: 'dp-features',
  templateUrl: './features.html',
  styleUrl: './features.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Button, ControlRule, PageHero, Panel, Section, SectionHeader],
})
export class Features {
  protected readonly areas = FEATURE_AREAS;
  protected readonly plannedIndex = indexAfterAreas(1);
  protected readonly boundaryIndex = indexAfterAreas(2);
  protected readonly planned = PLANNED;
  protected readonly outOfScope = OUT_OF_SCOPE;
  protected readonly getStarted = GET_STARTED;
}
