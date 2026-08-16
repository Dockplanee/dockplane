import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { PageContext } from '../../core/page-context';
import { Security } from './security';
import { SystemVersion } from './system-version';
import { Permissions } from '../../core/permissions';
import { Theme } from '../../core/theme';
import { Panel } from '../../ui/panel/panel';

/**
 * Operator preferences.
 *
 * Only settings the interface itself owns appear here. Instance configuration
 * such as sessions, retention and notification delivery belongs to the control
 * server and is not offered before that exists.
 */
@Component({
  selector: 'dp-settings',
  imports: [Security, SystemVersion, Panel],
  template: `
    <dp-panel heading="Appearance" icon="settings">
      <fieldset>
        <legend class="dp-label">Theme</legend>
        <p class="hint">Applies to this browser and is remembered for the next visit.</p>

        <div class="choices">
          @for (option of themes; track option.value) {
            <label class="choice" [class.selected]="theme.current() === option.value">
              <input
                type="radio"
                name="theme"
                [value]="option.value"
                [checked]="theme.current() === option.value"
                (change)="theme.set(option.value)"
              />
              {{ option.label }}
            </label>
          }
        </div>
      </fieldset>
    </dp-panel>

    <dp-security class="stacked" />

    <dp-system-version class="stacked" />
  `,
  styles: `
    .stacked {
      margin-top: 0.75rem;
    }

    fieldset {
      border: 0;
      padding: 0;
      margin: 0;
    }

    .hint {
      margin-top: 0.375rem;
      color: var(--dp-fg-muted);
      font-size: 0.8125rem;
      line-height: 1.6;
      max-width: 58ch;
    }

    .choices {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-top: 0.875rem;
    }

    .choice {
      display: inline-flex;
      align-items: center;
      gap: 0.4375rem;
      padding: 0.4375rem 0.75rem;
      border: 1px solid var(--dp-line-strong);
      border-radius: var(--dp-radius-sm);
      background-color: var(--dp-surface-alt);
      font-size: 0.8125rem;
      cursor: pointer;
    }

    .choice.selected {
      border-color: var(--dp-accent-border);
      color: var(--dp-accent-text);
    }

    .permissions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem;
      list-style: none;
      margin: 0.875rem 0 0;
      padding: 0;
    }

    .permissions li {
      padding: 0.125rem 0.4375rem;
      border: 1px solid var(--dp-line);
      border-radius: 4px;
      background-color: var(--dp-surface-inset);
      color: var(--dp-fg-muted);
      font-size: 0.6875rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Settings {
  protected readonly theme = inject(Theme);

  private readonly grants = inject(Permissions);
  protected readonly permissions = computed(() => [...this.grants.all()].sort());

  protected readonly themes = [
    { value: 'dark' as const, label: 'Dark' },
    { value: 'light' as const, label: 'Light' },
  ];

  constructor() {
    inject(PageContext).set({
      title: 'Settings',
      subtitle: 'Interface preferences, two-factor authentication and sessions',
    });
  }
}
