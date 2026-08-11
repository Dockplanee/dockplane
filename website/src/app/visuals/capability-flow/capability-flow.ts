import { ChangeDetectionStrategy, Component } from '@angular/core';

import { CodeBlock } from '../../ui/code-block/code-block';
import { PREVIEW_CAPABILITIES } from '../preview-data';

interface FlowStage {
  readonly boundary: string;
  readonly title: string;
  readonly detail: string;
}

const STAGES: readonly FlowStage[] = [
  {
    boundary: 'Browser session',
    title: 'Dockplane application',
    detail: 'An authenticated operator requests an operation on a workload.',
  },
  {
    boundary: 'HTTPS',
    title: 'Control server',
    detail:
      'Checks the session, applies backend authorization and attaches audit and correlation context.',
  },
  {
    boundary: 'Authenticated agent channel',
    title: 'Dockplane agent',
    detail:
      'Accepts a named capability with a validated payload and re-checks it before acting on the host.',
  },
  {
    boundary: 'Docker Engine API',
    title: 'Docker Engine',
    detail: 'Performs the requested operation locally on the managed host.',
  },
];

@Component({
  selector: 'dp-capability-flow',
  templateUrl: './capability-flow.html',
  styleUrl: './capability-flow.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CodeBlock],
})
export class CapabilityFlow {
  protected readonly stages = STAGES;
  protected readonly capabilities = PREVIEW_CAPABILITIES;
}
