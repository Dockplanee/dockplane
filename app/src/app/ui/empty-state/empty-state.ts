import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { Icon, IconName } from '../icon/icon';

/**
 * What is empty, why it matters, and what to do next.
 *
 * Operational empty states stay factual; they do not use jokes or filler.
 */
@Component({
  selector: 'dp-empty-state',
  imports: [Icon],
  template: `
    <dp-icon [name]="icon()" class="glyph" />
    <p class="title">{{ title() }}</p>
    @if (detail(); as text) {
      <p class="detail">{{ text }}</p>
    }
    <div class="actions">
      <ng-content />
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 3rem 1.5rem;
    }

    .glyph {
      width: 1.5rem;
      height: 1.5rem;
      color: var(--dp-fg-muted);
    }

    .title {
      margin-top: 0.875rem;
      font-size: 0.9375rem;
      font-weight: 550;
    }

    .detail {
      margin-top: 0.375rem;
      max-width: 32rem;
      color: var(--dp-fg-muted);
      font-size: 0.8125rem;
      line-height: 1.6;
    }

    .actions:not(:empty) {
      margin-top: 1.125rem;
      display: flex;
      gap: 0.5rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmptyState {
  readonly title = input.required<string>();
  readonly detail = input<string>();
  readonly icon = input<IconName>('info');
}
