import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { GET_STARTED } from '../../core/navigation';
import { Button } from '../../ui/button';
import { CodeBlock } from '../../ui/code-block/code-block';
import { Feature } from '../../ui/feature/feature';
import { PageHero } from '../../ui/page-hero/page-hero';
import { Panel } from '../../ui/panel';
import { Section } from '../../ui/section';
import { SectionHeader } from '../../ui/section-header/section-header';
import { ComposeProject } from '../../visuals/compose-project/compose-project';
import { HostFleet } from '../../visuals/host-fleet/host-fleet';
import { OperationalContext } from '../../visuals/operational-context/operational-context';

const EXAMPLE_PERMISSIONS = [
  'hosts.read',
  'containers.read',
  'containers.restart',
  'containers.logs',
  'compose.operate',
  'audit.read',
];

const IN_SCOPE = [
  'Docker hosts and host groups',
  'Containers and Compose projects',
  'Images, networks and volumes',
  'Logs, events and health state',
  'Host and container metrics',
  'Users, roles and resource-scoped permissions',
  'Agent enrollment and revocation',
  'Audit history',
];

@Component({
  selector: 'dp-product',
  templateUrl: './product.html',
  styleUrl: './product.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    Button,
    CodeBlock,
    Feature,
    PageHero,
    Panel,
    Section,
    SectionHeader,
    ComposeProject,
    HostFleet,
    OperationalContext,
  ],
})
export class Product {
  protected readonly getStarted = GET_STARTED;
  protected readonly permissions = EXAMPLE_PERMISSIONS;
  protected readonly inScope = IN_SCOPE;
}
