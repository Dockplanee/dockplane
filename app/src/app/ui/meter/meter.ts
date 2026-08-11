import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Percentage bar for CPU, memory and disk.
 *
 * The numeric value is always shown next to the bar; the bar reinforces it.
 * Thresholds shift the tone so a saturated resource is visible while scanning.
 */
@Component({
  selector: 'dp-meter',
  template: `
    <span class="value">{{ display() }}</span>
    <span class="track" [class]="tone()">
      <span class="fill" [style.width.%]="clamped()"></span>
    </span>
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-variant-numeric: tabular-nums;
    }

    .value {
      min-width: 2.5rem;
      font-size: 0.8125rem;
    }

    .track {
      position: relative;
      width: 3.5rem;
      height: 4px;
      border-radius: 2px;
      background-color: var(--dp-track);
      overflow: hidden;
    }

    .fill {
      position: absolute;
      inset-block: 0;
      left: 0;
      border-radius: 2px;
      background-color: var(--dp-status-ok);
    }

    .track.warn .fill {
      background-color: var(--dp-status-warn);
    }

    .track.critical .fill {
      background-color: var(--dp-status-critical);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Meter {
  readonly percent = input.required<number>();

  /** Screen-reader description, for example `Memory 44 percent, 7.0 of 16 GiB`. */
  readonly label = input.required<string>();

  protected readonly clamped = computed(() => Math.min(100, Math.max(0, this.percent())));
  protected readonly display = computed(() => `${Math.round(this.percent())}%`);

  protected readonly tone = computed(() => {
    const value = this.percent();
    if (value >= 90) {
      return 'critical';
    }
    return value >= 70 ? 'warn' : 'ok';
  });
}
