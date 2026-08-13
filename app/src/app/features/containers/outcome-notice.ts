import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { Icon } from '../../ui/icon/icon';

/**
 * An outcome the server could not confirm.
 *
 * Deliberately not an error. The request reached the host and the answer was
 * lost, so the container may have been created, changed or removed exactly as
 * asked — and telling an operator it failed would be telling them something
 * nobody established.
 *
 * There is no control here that sends the request again. Repeating a change
 * that may already have taken is the one thing this state must not make easy;
 * Dockplane settles it from the host instead.
 */
@Component({
  selector: 'dp-outcome-notice',
  imports: [RouterLink, Icon],
  template: `
    <aside class="notice" role="status">
      <dp-icon name="alertTriangle" aria-hidden="true" />
      <div>
        <p class="notice__title">{{ heading() }}</p>
        <p class="notice__detail">{{ message() }}</p>
        <p class="notice__links">
          @if (containerId(); as id) {
            <a [routerLink]="['/containers', id]">View the container</a>
          } @else {
            <a routerLink="/containers">View containers</a>
          }
        </p>
      </div>
    </aside>
  `,
  styles: `
    .notice {
      display: flex;
      gap: 0.75rem;
      align-items: flex-start;
      margin-bottom: 1rem;
      padding: 0.875rem 1rem;
      border: 1px solid var(--dp-status-warn);
      border-radius: var(--dp-radius-md);
      background-color: var(--dp-status-warn-soft);
    }

    dp-icon {
      flex: none;
      margin-top: 0.0625rem;
      color: var(--dp-status-warn);
    }

    .notice__title {
      margin: 0;
      font-size: 0.875rem;
      font-weight: 600;
    }

    .notice__detail {
      margin: 0.25rem 0 0;
      font-size: 0.8125rem;
      color: var(--dp-text-muted);
      max-width: 68ch;
    }

    .notice__links {
      margin: 0.5rem 0 0;
      font-size: 0.8125rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OutcomeNotice {
  readonly heading = input('The result has not been confirmed');
  readonly message = input.required<string>();
  readonly containerId = input<string | undefined>(undefined);
}
