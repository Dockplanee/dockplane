import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { Logo } from '../../ui/logo/logo';

/**
 * Chrome shared by the interface previews. It frames projected content the way
 * the application presents a view, without imitating browser or OS window
 * decoration.
 */
@Component({
  selector: 'dp-app-frame',
  templateUrl: './app-frame.html',
  styleUrl: './app-frame.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Logo],
})
export class AppFrame {
  readonly view = input.required<string>();
  readonly context = input<string>();
}
