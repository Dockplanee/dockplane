import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Scroll container and result count around a list view's table.
 *
 * Dense operational tables keep their technical columns on narrow viewports and
 * scroll horizontally rather than dropping information.
 */
@Component({
  selector: 'dp-table-shell',
  template: `
    <div class="scroll" [style.--dp-table-min-width]="minWidth()">
      <ng-content />
    </div>

    @if (count() !== undefined) {
      <p class="count">
        @if (total() !== undefined && total() !== count()) {
          Showing {{ count() }} of {{ total() }} {{ noun() }}
        } @else {
          {{ count() }} {{ count() === 1 ? noun() : nounPlural() }}
        }
      </p>
    }
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }

    .scroll {
      overflow-x: auto;
      overscroll-behavior-x: contain;
    }

    .scroll ::ng-deep table {
      min-width: var(--dp-table-min-width, 0);
    }

    .count {
      padding: 0.625rem 1rem;
      border-top: 1px solid var(--dp-line);
      color: var(--dp-fg-muted);
      font-size: 0.75rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TableShell {
  /** Rows currently shown. Omit to hide the count line. */
  readonly count = input<number>();

  /** Rows before filtering, when different from `count`. */
  readonly total = input<number>();

  readonly noun = input('item');
  readonly nounPlural = input('items');

  /** Width below which the table scrolls instead of compressing. */
  readonly minWidth = input('44rem');
}
