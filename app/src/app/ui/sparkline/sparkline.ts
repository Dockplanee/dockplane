import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

const WIDTH = 52;
const HEIGHT = 16;

/**
 * Inline trend for a single series.
 *
 * It carries no axis or scale and is deliberately never the only place a value
 * appears: the figure it accompanies is always rendered as text.
 */
@Component({
  selector: 'dp-sparkline',
  template: `
    <svg [attr.viewBox]="viewBox" fill="none" aria-hidden="true" focusable="false">
      <path [attr.d]="path()" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" />
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      width: 3.25rem;
      height: 1rem;
      color: var(--dp-status-ok);
    }

    svg {
      width: 100%;
      height: 100%;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Sparkline {
  readonly values = input.required<readonly number[]>();

  protected readonly viewBox = `0 0 ${WIDTH} ${HEIGHT}`;

  protected readonly path = computed(() => {
    const values = this.values();

    if (values.length < 2) {
      return '';
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const step = WIDTH / (values.length - 1);
    const inset = 1.5;
    const usable = HEIGHT - inset * 2;

    return values
      .map((value, index) => {
        const x = (index * step).toFixed(2);
        const y = (HEIGHT - inset - ((value - min) / span) * usable).toFixed(2);
        return `${index === 0 ? 'M' : 'L'}${x} ${y}`;
      })
      .join(' ');
  });
}
