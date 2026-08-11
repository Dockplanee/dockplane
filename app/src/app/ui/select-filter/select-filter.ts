import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

/** Labelled dropdown filter used in list toolbars. */
@Component({
  selector: 'dp-select-filter',
  template: `
    <label class="dp-sr-only" [attr.for]="id()">{{ label() }}</label>
    <select
      class="dp-field"
      [id]="id()"
      [value]="value()"
      (change)="valueChange.emit($any($event.target).value)"
    >
      @for (option of options(); track option.value) {
        <option [value]="option.value">{{ option.label }}</option>
      }
    </select>
  `,
  styles: `
    :host {
      display: inline-flex;
    }

    select {
      width: auto;
      min-width: 8rem;
      cursor: pointer;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelectFilter {
  readonly id = input.required<string>();
  readonly label = input.required<string>();
  readonly options = input.required<readonly FilterOption[]>();
  readonly value = input('all');

  readonly valueChange = output<string>();
}
