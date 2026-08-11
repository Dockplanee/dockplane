import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { externalLink } from '../../core/site.config';
import { CodeBlock } from '../../ui/code-block/code-block';
import { PageHero } from '../../ui/page-hero/page-hero';
import { Panel } from '../../ui/panel';
import { Section } from '../../ui/section';
import { SectionHeader } from '../../ui/section-header/section-header';

interface DocArea {
  readonly title: string;
  readonly summary: string;
  readonly topics: readonly string[];
}

const TOPOLOGY = [
  'Dockplane control host',
  '├── web application',
  '├── control API',
  '└── PostgreSQL',
  '',
  'Docker host A',
  '└── Dockplane agent',
  '',
  'Docker host B',
  '└── Dockplane agent',
];

const CONNECT_STEPS = [
  'Sign in as an administrator.',
  'Create a short-lived enrollment token.',
  'Install the Dockplane agent on the Docker host.',
  'Configure the Dockplane control-server URL.',
  'Complete enrollment.',
  'Verify the host identity in Dockplane.',
  'Confirm Docker capability discovery.',
];

const DOC_AREAS: readonly DocArea[] = [
  {
    title: 'Getting started',
    summary: 'Deployment topology and the flow for connecting the first Docker host.',
    topics: ['Installation', 'Connect the first host'],
  },
  {
    title: 'Architecture',
    summary: 'How the control server, agents and Docker hosts fit together.',
    topics: ['Agent protocol', 'Security model'],
  },
  {
    title: 'Integrations',
    summary: 'How the agent talks to the local Docker Engine and where the limits are.',
    topics: ['Docker integration'],
  },
  {
    title: 'Operations',
    summary: 'What to check when a host, an action or the control plane misbehaves.',
    topics: ['Troubleshooting', 'Recovery'],
  },
];

@Component({
  selector: 'dp-docs',
  templateUrl: './docs.html',
  styleUrl: './docs.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, CodeBlock, PageHero, Panel, Section, SectionHeader],
})
export class Docs {
  protected readonly topology = TOPOLOGY;
  protected readonly connectSteps = CONNECT_STEPS;
  protected readonly areas = DOC_AREAS;
  protected readonly releasesUrl = externalLink('releases');
}
