import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Heading block shared by the list views.
 *
 * It stays a single line of title plus one line of context; the application
 * does not use a decorative hero per page.
 */
@Component({
  selector: 'dp-page-header',
  template: `
    <div class="text">
      <h1>{{ title() }}</h1>
      @if (subtitle(); as text) {
        <p class="subtitle">{{ text }}</p>
      }
    </div>
    <div class="actions">
      <ng-content />
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.75rem 1rem;
      margin-bottom: 1.25rem;
    }

    h1 {
      font-size: 1.25rem;
      line-height: 1.25;
    }

    .subtitle {
      margin-top: 0.25rem;
      color: var(--dp-fg-muted);
      font-size: 0.8125rem;
    }

    .actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly subtitle = input<string>();
}
