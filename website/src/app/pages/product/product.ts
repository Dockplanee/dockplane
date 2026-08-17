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

/*
 * Real permission keys, taken from api/src/rbac/permissions.ts. A plausible
 * one that does not exist reads exactly like a real one on a marketing page,
 * and `compose.operate` was on this list for three releases without ever
 * having been a permission anybody could grant.
 */
export const EXAMPLE_PERMISSIONS = [
  'hosts.read',
  'containers.restart',
  'containers.logs',
  'containers.delete',
  'stacks.deploy',
  'audit.read',
];

/*
 * What belongs in the product, which is not the same as what it does today.
 * Written so that neither reading is wrong: everything here exists, and the
 * features page is where the planned direction is marked as planned.
 */
export const IN_SCOPE = [
  'Docker hosts and their agents',
  'Containers, created here or discovered',
  'Managed Compose stacks and their revisions',
  'Compose projects found on a host',
  'Logs, events and health state',
  'Host metrics',
  'Users, roles and backend-enforced permissions',
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
