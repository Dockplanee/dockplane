import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export interface DetailItem {
  readonly label: string;
  readonly value: string;
  /** Technical identifiers render in monospace. */
  readonly mono?: boolean;
  /** A second line, for what qualifies the value rather than repeating it. */
  readonly secondary?: string;
}

/** Key/value block used by the detail views. */
@Component({
  selector: 'dp-detail-list',
  template: `
    <dl>
      @for (item of items(); track item.label) {
        <div>
          <dt>{{ item.label }}</dt>
          <dd [class.dp-mono]="item.mono">
            {{ item.value }}
            @if (item.secondary) {
              <span class="secondary">{{ item.secondary }}</span>
            }
          </dd>
        </div>
      }
    </dl>
  `,
  styles: `
    :host {
      display: block;
    }

    dl {
      display: grid;
      gap: 0.75rem 1.5rem;
      grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    }

    .secondary {
      display: block;
      color: var(--dp-fg-muted);
      font-family: var(--font-sans);
      font-size: var(--dp-text-label);
      line-height: 1.4;
    }

    dt {
      color: var(--dp-fg-muted);
      font-size: 0.6875rem;
      font-family: var(--font-mono);
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    dd {
      margin-top: 0.1875rem;
      font-size: 0.8125rem;
      overflow-wrap: anywhere;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DetailList {
  readonly items = input.required<readonly DetailItem[]>();
}
