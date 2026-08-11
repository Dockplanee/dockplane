import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';

import { Auth } from './core/auth.service';
import { Session } from './core/session';
import { SearchPalette } from './layout/search-palette/search-palette';
import { Sidebar } from './layout/sidebar/sidebar';
import { Topbar } from './layout/topbar/topbar';

const COLLAPSE_STORAGE_KEY = 'dockplane-sidebar-collapsed';

@Component({
  selector: 'dp-root',
  imports: [RouterOutlet, Sidebar, Topbar, SearchPalette],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.control.k)': 'openSearch($event)',
    '(document:keydown.meta.k)': 'openSearch($event)',
  },
})
export class App {
  private readonly router = inject(Router);
  private readonly session = inject(Session);

  private readonly main = viewChild.required<ElementRef<HTMLElement>>('main');
  private readonly palette = viewChild.required(SearchPalette);

  protected readonly collapsed = signal(false);
  protected readonly drawerOpen = signal(false);

  /**
   * True until the control server has answered who is signed in.
   *
   * The shell stays hidden meanwhile. Rendering it first and correcting
   * afterwards would show an operator a navigation they may not have, and would
   * flash protected chrome to someone who is not signed in at all.
   */
  protected readonly resolving = this.session.isResolving;

  /** The shell belongs to a signed-in operator; sign-in renders on its own. */
  protected readonly signedIn = this.session.isAuthenticated;

  private initialNavigation = true;

  constructor() {
    const auth = inject(Auth);

    // One session check at start-up. Guards await the same call rather than
    // starting their own, so a deep link resolves once.
    void auth.restore();

    afterNextRender(() => this.collapsed.set(this.readCollapsed()));

    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.onNavigationEnd());
  }

  protected toggleCollapsed(): void {
    this.collapsed.update((value) => !value);

    try {
      localStorage.setItem(COLLAPSE_STORAGE_KEY, String(this.collapsed()));
    } catch {
      // Storage may be unavailable; the choice then applies to this session only.
    }
  }

  protected openDrawer(): void {
    this.drawerOpen.set(true);
  }

  protected closeDrawer(): void {
    this.drawerOpen.set(false);
  }

  protected openSearch(event: Event): void {
    event.preventDefault();
    this.palette().open();
  }

  private onNavigationEnd(): void {
    this.drawerOpen.set(false);

    // The reading position does not move on a client-side navigation, so focus
    // is handed to the new view.
    if (this.initialNavigation) {
      this.initialNavigation = false;
      return;
    }

    this.main().nativeElement.focus({ preventScroll: true });
    this.main().nativeElement.scrollTo({ top: 0 });
  }

  private readCollapsed(): boolean {
    try {
      return localStorage.getItem(COLLAPSE_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  }
}
