import { ChangeDetectionStrategy, Component, booleanAttribute, input } from '@angular/core';

import { Icon, IconName } from '../icon/icon';

/**
 * Bordered container with an optional titled header.
 *
 * The heading is a real `h2`, so panels contribute to the document outline and
 * a table inside a panel can reference it.
 */
@Component({
  selector: 'dp-panel',
  imports: [Icon],
  template: `
    @if (heading(); as text) {
      <div class="head">
        @if (icon(); as name) {
          <dp-icon [name]="name" class="icon" />
        }
        <h2 [id]="headingId()">{{ text }}</h2>
        <div class="head-actions">
          <ng-content select="[panelActions]" />
        </div>
      </div>
    }

    <div class="body" [class.body--flush]="flush()">
      <ng-content />
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--dp-line);
      border-radius: var(--dp-radius-lg);
      background-color: var(--dp-surface);
      min-width: 0;
    }

    .head {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.875rem 1rem;
      border-bottom: 1px solid var(--dp-line);
    }

    .icon {
      color: var(--dp-fg-muted);
    }

    h2 {
      font-size: 0.9375rem;
      font-weight: 600;
    }

    .head-actions {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .body {
      padding: 1rem;
      min-width: 0;
    }

    .body--flush {
      padding: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Panel {
  readonly heading = input<string>();
  readonly icon = input<IconName>();
  readonly headingId = input<string>();

  /** Removes body padding, for panels whose content is a full-width table. */
  readonly flush = input(false, { transform: booleanAttribute });
}
