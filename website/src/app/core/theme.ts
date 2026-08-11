import { DOCUMENT } from '@angular/common';
import { Injectable, afterNextRender, inject, signal } from '@angular/core';

export type ThemeName = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'dockplane-theme';

/**
 * Resolves and persists the colour theme.
 *
 * Prerendered pages ship without a `data-theme` attribute so the operating
 * system preference applies through a media query. A stored preference is
 * re-applied by public/initial-theme.js before first paint; this service keeps
 * the in-page state in sync once Angular takes over.
 */
@Injectable({ providedIn: 'root' })
export class Theme {
  private readonly document = inject(DOCUMENT);
  private readonly active = signal<ThemeName>('dark');

  readonly current = this.active.asReadonly();

  constructor() {
    afterNextRender(() => this.active.set(this.detectActiveTheme()));
  }

  toggle(): void {
    this.set(this.active() === 'dark' ? 'light' : 'dark');
  }

  set(theme: ThemeName): void {
    this.active.set(theme);
    this.document.documentElement.setAttribute('data-theme', theme);

    try {
      this.document.defaultView?.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage may be unavailable; the theme still applies for this document.
    }
  }

  private detectActiveTheme(): ThemeName {
    const declared = this.document.documentElement.getAttribute('data-theme');

    if (declared === 'light' || declared === 'dark') {
      return declared;
    }

    const prefersDark =
      this.document.defaultView?.matchMedia('(prefers-color-scheme: dark)').matches ?? true;

    return prefersDark ? 'dark' : 'light';
  }
}
