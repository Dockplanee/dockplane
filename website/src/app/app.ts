import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRouteSnapshot, NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';

import { PageMetadata } from './core/page-metadata';
import { Seo } from './core/seo';
import { SiteFooter } from './layout/site-footer/site-footer';
import { SiteHeader } from './layout/site-header/site-header';

const MAIN_ID = 'main-content';

@Component({
  selector: 'dp-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, SiteHeader, SiteFooter],
})
export class App {
  private readonly router = inject(Router);
  private readonly seo = inject(Seo);

  private readonly main = viewChild.required<ElementRef<HTMLElement>>('main');

  protected readonly mainId = MAIN_ID;

  /**
   * Absolute so the fragment resolves against the current page rather than the
   * document base URL. Keeping it a real link means the control still works on
   * the prerendered page before hydration.
   */
  protected readonly skipHref = signal(`/#${MAIN_ID}`);

  private initialNavigation = true;

  constructor() {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((event) => this.onNavigationEnd(event));
  }

  protected skipToContent(event: Event): void {
    event.preventDefault();
    this.focusMain();
  }

  private onNavigationEnd(event: NavigationEnd): void {
    const path = this.stripFragment(event.urlAfterRedirects);
    const metadata = this.resolveMetadata(this.router.routerState.snapshot.root);

    this.skipHref.set(`${path}#${MAIN_ID}`);

    if (metadata) {
      this.seo.apply(metadata, path);
    }

    // A client-side navigation replaces the page without moving the reading
    // position, so focus is handed to the new document body.
    if (this.initialNavigation) {
      this.initialNavigation = false;
      return;
    }

    this.focusMain();
  }

  private focusMain(): void {
    this.main().nativeElement.focus({ preventScroll: true });
  }

  private resolveMetadata(root: ActivatedRouteSnapshot): PageMetadata | undefined {
    let route: ActivatedRouteSnapshot | null = root;
    let metadata: PageMetadata | undefined;

    while (route) {
      metadata = (route.data['metadata'] as PageMetadata | undefined) ?? metadata;
      route = route.firstChild;
    }

    return metadata;
  }

  private stripFragment(url: string): string {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
  }
}
