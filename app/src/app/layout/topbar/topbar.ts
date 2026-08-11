import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';

import { Auth } from '../../core/auth.service';
import { PageContext } from '../../core/page-context';
import { Session } from '../../core/session';
import { Theme } from '../../core/theme';
import { DockplaneApi } from '../../data/dockplane-api';
import { Icon } from '../../ui/icon/icon';

@Component({
  selector: 'dp-topbar',
  imports: [RouterLink, Icon],
  templateUrl: './topbar.html',
  styleUrl: './topbar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(keydown.escape)': 'closeUserMenu()',
  },
})
export class Topbar {
  private readonly api = inject(DockplaneApi);
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);
  private readonly session = inject(Session);
  private readonly theme = inject(Theme);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly menuOpened = output<void>();
  readonly searchOpened = output<void>();

  protected readonly page = inject(PageContext).current;
  protected readonly userMenuOpen = signal(false);

  /** The signed-in operator, as the control server reports them. */
  protected readonly user = this.session.user;
  protected readonly roles = this.session.roles;

  protected readonly themeAction = computed(() =>
    this.theme.current() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
  );

  private readonly hosts = toSignal(this.api.hosts(), { initialValue: [] });

  /**
   * How much of the fleet is reporting.
   *
   * Derived from the hosts the server returns rather than from a separate
   * status endpoint: one source of truth, and no way for the two to disagree.
   */
  protected readonly connection = computed(() => {
    const hosts = this.hosts();
    const reporting = hosts.filter((host) => !host.stale && host.status !== 'offline').length;

    return { hostsReporting: reporting, hostsTotal: hosts.length };
  });

  protected readonly allReporting = computed(() => {
    const state = this.connection();

    return state.hostsTotal > 0 && state.hostsReporting === state.hostsTotal;
  });

  /** Ends the session on the server, then leaves nothing behind on screen. */
  protected signOut(): void {
    this.closeUserMenu();

    this.auth.logout().subscribe(() => {
      void this.router.navigate(['/login']);
    });
  }

  protected toggleTheme(): void {
    this.theme.toggle();
  }

  protected toggleUserMenu(): void {
    this.userMenuOpen.update((open) => !open);
  }

  protected closeUserMenu(): void {
    this.userMenuOpen.set(false);
  }

  protected onDocumentClick(event: MouseEvent): void {
    if (this.userMenuOpen() && !this.host.nativeElement.contains(event.target as Node)) {
      this.userMenuOpen.set(false);
    }
  }
}
