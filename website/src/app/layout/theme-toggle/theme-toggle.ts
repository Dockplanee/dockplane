import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { Theme } from '../../core/theme';

@Component({
  selector: 'dp-theme-toggle',
  templateUrl: './theme-toggle.html',
  styleUrl: './theme-toggle.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThemeToggle {
  private readonly theme = inject(Theme);

  readonly current = this.theme.current;

  readonly actionLabel = computed(() =>
    this.current() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
  );

  toggle(): void {
    this.theme.toggle();
  }
}
