import { ChangeDetectionStrategy, Component, booleanAttribute, input, output } from '@angular/core';

import { Button } from '../button';
import { Icon } from '../icon/icon';

/**
 * Operational failure presentation.
 *
 * Shows a readable cause, the stable error code and the request ID needed for
 * diagnostics. Raw stack traces are never surfaced.
 */
@Component({
  selector: 'dp-error-state',
  imports: [Button, Icon],
  template: `
    <dp-icon name="alertTriangle" class="glyph" />

    <div class="body">
      <p class="message">{{ message() }}</p>

      <dl class="meta">
        @if (code(); as value) {
          <div>
            <dt>Code</dt>
            <dd class="dp-mono">{{ value }}</dd>
          </div>
        }
        @if (requestId(); as value) {
          <div>
            <dt>Request ID</dt>
            <dd class="dp-mono">{{ value }}</dd>
          </div>
        }
      </dl>
    </div>

    @if (retryable()) {
      <button type="button" dpButton variant="secondary" (click)="retry.emit()">Try again</button>
    }
  `,
  styles: `
    :host {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 1rem;
      border: 1px solid var(--dp-line);
      border-left: 2px solid var(--dp-status-critical);
      border-radius: var(--dp-radius-md);
      background-color: var(--dp-status-critical-soft);
    }

    .glyph {
      margin-top: 0.0625rem;
      color: var(--dp-status-critical);
    }

    .body {
      flex: 1;
      min-width: 0;
    }

    .message {
      font-size: 0.8125rem;
      line-height: 1.55;
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 1.25rem;
      margin-top: 0.5rem;
    }

    .meta div {
      display: flex;
      align-items: baseline;
      gap: 0.375rem;
    }

    dt {
      color: var(--dp-fg-muted);
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    dd {
      font-size: 0.75rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ErrorState {
  readonly message = input.required<string>();
  readonly code = input<string>();
  readonly requestId = input<string>();

  /** Only offered when repeating the request is safe. */
  readonly retryable = input(false, { transform: booleanAttribute });

  readonly retry = output<void>();
}
