import { ChangeDetectionStrategy, Component, ElementRef, signal, viewChild } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { GET_STARTED, PRIMARY_NAV } from '../../core/navigation';
import { Button } from '../../ui/button';
import { Logo } from '../../ui/logo/logo';
import { ThemeToggle } from '../theme-toggle/theme-toggle';

@Component({
  selector: 'dp-site-header',
  templateUrl: './site-header.html',
  styleUrl: './site-header.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, Button, Logo, ThemeToggle],
  host: {
    '(keydown.escape)': 'dismissMenu()',
  },
})
export class SiteHeader {
  protected readonly navigation = PRIMARY_NAV;
  protected readonly getStarted = GET_STARTED;

  protected readonly menuOpen = signal(false);

  private readonly menuButton = viewChild.required<ElementRef<HTMLButtonElement>>('menuButton');

  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  /** Escape returns the reader to the control that opened the panel. */
  protected dismissMenu(): void {
    if (!this.menuOpen()) {
      return;
    }

    this.menuOpen.set(false);
    this.menuButton().nativeElement.focus();
  }
}
