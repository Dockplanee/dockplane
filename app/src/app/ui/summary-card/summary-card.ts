import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { StatusTone } from '../../domain/status';
import { Icon, IconName } from '../icon/icon';
import { Sparkline } from '../sparkline/sparkline';

/**
 * Compact figure for the overview.
 *
 * The dashboard carries exactly four of these. The trend is supporting detail;
 * the value it summarises is always present as text.
 */
@Component({
  selector: 'dp-summary-card',
  imports: [Icon, Sparkline],
  template: `
    <span class="badge" [class]="'tone-' + tone()">
      <dp-icon [name]="icon()" />
    </span>

    <div class="content">
      <div class="head">
        <h3>{{ label() }}</h3>
        @if (change(); as text) {
          <span class="change">{{ text }}<span class="window"> vs last 24h</span></span>
        }
      </div>

      <p class="value">{{ value() }}</p>

      <div class="foot">
        <p class="detail">{{ detail() }}</p>
        @if (trend().length > 1) {
          <dp-sparkline [values]="trend()" [class]="'tone-' + tone()" />
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      gap: 0.875rem;
      padding: 1rem;
      border: 1px solid var(--dp-line);
      border-radius: var(--dp-radius-lg);
      background-color: var(--dp-surface);
      min-width: 0;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.25rem;
      height: 2.25rem;
      flex: none;
      border-radius: var(--dp-radius-md);
      background-color: var(--dp-surface-inset);
      color: var(--dp-fg-muted);
    }

    .badge.tone-ok {
      background-color: var(--dp-status-ok-soft);
      color: var(--dp-status-ok);
    }

    .badge.tone-warn {
      background-color: var(--dp-status-warn-soft);
      color: var(--dp-status-warn);
    }

    .badge.tone-critical {
      background-color: var(--dp-status-critical-soft);
      color: var(--dp-status-critical);
    }

    .badge.tone-info {
      background-color: var(--dp-status-info-soft);
      color: var(--dp-status-info);
    }

    .content {
      flex: 1;
      min-width: 0;
    }

    .head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.5rem;
    }

    h3 {
      font-size: 0.8125rem;
      font-weight: 550;
    }

    .change {
      color: var(--dp-fg-muted);
      font-size: 0.6875rem;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .window {
      display: none;
    }

    @media (min-width: 1440px) {
      .window {
        display: inline;
      }
    }

    .value {
      margin-top: 0.125rem;
      font-size: 1.625rem;
      font-weight: 600;
      line-height: 1.15;
      letter-spacing: -0.02em;
      font-variant-numeric: tabular-nums;
    }

    .foot {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 0.5rem;
      margin-top: 0.25rem;
    }

    .detail {
      color: var(--dp-fg-muted);
      font-size: 0.75rem;
    }

    dp-sparkline.tone-warn {
      color: var(--dp-status-warn);
    }

    dp-sparkline.tone-critical {
      color: var(--dp-status-critical);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SummaryCard {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly detail = input.required<string>();
  readonly icon = input.required<IconName>();
  readonly tone = input<StatusTone>('neutral');

  /** Signed difference against the previous day, for example `+1`. */
  readonly change = input<string>();
  readonly trend = input<readonly number[]>([]);

  protected readonly hasTrend = computed(() => this.trend().length > 1);
}
