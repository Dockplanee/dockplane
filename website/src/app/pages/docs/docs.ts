import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { externalLink } from '../../core/site.config';
import { CodeBlock } from '../../ui/code-block/code-block';
import { PageHero } from '../../ui/page-hero/page-hero';
import { Panel } from '../../ui/panel';
import { Section } from '../../ui/section';
import { SectionHeader } from '../../ui/section-header/section-header';
import { DOC_SECTIONS, DOCS_REPOSITORY } from './docs.data';

const TOPOLOGY = [
  'Control plane host',
  '├── Caddy            80, 443',
  '├── control server   not published',
  '└── PostgreSQL       not published',
  '',
  'Docker host A',
  '└── Dockplane agent  ──┐',
  '',
  'Docker host B',
  '└── Dockplane agent  ──┤',
  '                       │',
  '        outbound, mutual TLS, 9443',
];

// What the operator actually does. Everything after the second step is the
// command's work, and the interface reports each one as the control plane
// observes it.
const CONNECT_STEPS = [
  'Sign in and open Hosts → Add host.',
  'Copy the command and run it on the Docker host.',
  'The agent package is downloaded and its checksum verified.',
  'The agent generates its key pair and enrolls.',
  'The service starts and connects outbound.',
  'The host appears with its containers and Compose projects.',
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
  protected readonly sections = DOC_SECTIONS;
  protected readonly docsUrl = DOCS_REPOSITORY;
  protected readonly releasesUrl = externalLink('releases');
}
