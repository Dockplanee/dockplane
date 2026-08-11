import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * Column header control.
 *
 * Lives inside a `<th>` that carries `aria-sort`, so the sort state is exposed
 * once, on the cell, rather than being inferred from the icon.
 */
@Component({
  selector: 'dp-sort-button',
  template: `
    <button type="button" (click)="sort.emit()">
      <span><ng-content /></span>
      <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false" [class]="direction() ?? 'none'">
        <path d="M6 2.5L8.6 5.5H3.4z" class="up" />
        <path d="M6 9.5L3.4 6.5h5.2z" class="down" />
      </svg>
    </button>
  `,
  styles: `
    :host {
      display: block;
    }

    button {
      display: inline-flex;
      align-items: center;
      gap: 0.3125rem;
      padding: 0;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      letter-spacing: inherit;
      text-transform: inherit;
      cursor: pointer;
    }

    button:hover {
      color: var(--dp-fg);
    }

    svg {
      width: 0.6875rem;
      height: 0.6875rem;
      fill: currentcolor;
    }

    svg path {
      opacity: 0.28;
    }

    svg.asc .up,
    svg.desc .down {
      opacity: 1;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SortButton {
  /** Active direction, or undefined when another column is sorted. */
  readonly direction = input<'asc' | 'desc'>();

  readonly sort = output<void>();
}
