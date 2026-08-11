import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type LogoVariant = 'lockup' | 'mark';

@Component({
  selector: 'dp-logo',
  templateUrl: './logo.html',
  styleUrl: './logo.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Logo {
  /** `lockup` pairs the mark with the wordmark, `mark` renders the symbol alone. */
  readonly variant = input<LogoVariant>('lockup');

  /** Accessible name used when the mark is rendered without the wordmark. */
  readonly label = input('Dockplane');
}
