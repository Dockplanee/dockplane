import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Monospace block for commands, identifiers and capability names. */
@Component({
  selector: 'dp-code-block',
  templateUrl: './code-block.html',
  styleUrl: './code-block.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CodeBlock {
  readonly lines = input.required<readonly string[]>();

  /** Describes the block for assistive technology when the lines need context. */
  readonly label = input<string>();
}
