import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { GET_STARTED } from '../../core/navigation';
import { externalLink } from '../../core/site.config';
import { Button } from '../../ui/button';
import { ControlRule } from '../../ui/control-rule/control-rule';
import { Feature } from '../../ui/feature/feature';
import { Section } from '../../ui/section';
import { SectionHeader } from '../../ui/section-header/section-header';
import { CapabilityFlow } from '../../visuals/capability-flow/capability-flow';
import { ComposeProject } from '../../visuals/compose-project/compose-project';
import { HostFleet } from '../../visuals/host-fleet/host-fleet';
import { OperationalContext } from '../../visuals/operational-context/operational-context';
import { OverviewPreview } from '../../visuals/overview-preview/overview-preview';

@Component({
  selector: 'dp-home',
  templateUrl: './home.html',
  styleUrl: './home.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    Button,
    ControlRule,
    Feature,
    Section,
    SectionHeader,
    CapabilityFlow,
    ComposeProject,
    HostFleet,
    OperationalContext,
    OverviewPreview,
  ],
})
export class Home {
  protected readonly getStarted = GET_STARTED;
  protected readonly sourceUrl = externalLink('source');
}
