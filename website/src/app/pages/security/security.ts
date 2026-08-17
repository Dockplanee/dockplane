import { ChangeDetectionStrategy, Component } from '@angular/core';

import { externalLink } from '../../core/site.config';
import { Button } from '../../ui/button';
import { PageHero } from '../../ui/page-hero/page-hero';
import { Panel } from '../../ui/panel';
import { Section } from '../../ui/section';
import { SectionHeader } from '../../ui/section-header/section-header';
import { CapabilityFlow } from '../../visuals/capability-flow/capability-flow';

const ENROLLMENT_STEPS = [
  'An administrator creates a short-lived enrollment token.',
  'The agent enrolls over authenticated TLS.',
  'The agent receives its own device-specific credential.',
  'Ongoing communication uses a device-authenticated encrypted channel.',
  'A single agent credential can be revoked without replacing the others.',
  'Enrollment and revocation are recorded in the audit history.',
];

@Component({
  selector: 'dp-security',
  templateUrl: './security.html',
  styleUrl: './security.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Button, PageHero, Panel, Section, SectionHeader, CapabilityFlow],
})
export class Security {
  protected readonly enrollmentSteps = ENROLLMENT_STEPS;
  protected readonly advisoryUrl = externalLink('securityAdvisory');
  protected readonly securityModelUrl = externalLink('securityModel');
}
