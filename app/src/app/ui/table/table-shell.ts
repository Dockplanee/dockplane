import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Layout container and result count around a list view's table.
 *
 * Dense operational tables used to keep every technical column at every width
 * and scroll sideways instead of dropping any. Measured against 0.2.0 that put
 * a container's state, health and actions outside the window on everything
 * narrower than about 1500 pixels, while the page itself reported no overflow —
 * so nothing signalled that the rest of the row existed.
 *
 * The width that decides the layout is this element's, not the window's. A
 * 1440-pixel window carries a 1150-pixel content area once the sidebar is
 * open, which is narrower than the containers table wants; a 768-pixel window
 * has no sidebar and carries 718. Asking the window would call the first full
 * and the second narrow, which is backwards.
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

      /* What the table measures itself against. See dp-table in components.css. */
      container-type: inline-size;
      container-name: dp-table;
    }

    .scroll {
      overflow-x: auto;
      overscroll-behavior-x: contain;
    }

    /*
     * A floor for the full layout only. Below it the table drops its secondary
     * columns and then stacks, so holding a minimum would reintroduce exactly
     * the sideways scroll those modes exist to remove.
     */
    @container dp-table (min-width: 76rem) {
      .scroll ::ng-deep table {
        min-width: var(--dp-table-min-width, 0);
      }
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
