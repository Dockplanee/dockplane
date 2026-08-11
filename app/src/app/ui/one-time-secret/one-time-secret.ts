import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  input,
  signal,
} from '@angular/core';

import { Button } from '../button';
import { Icon } from '../icon/icon';

/**
 * A value the server will show exactly once.
 *
 * Enrollment tokens and recovery codes share a problem: they exist in clear for
 * one moment and never again. This component holds them for that moment and no
 * longer — nothing is written to storage, the value is dropped when the view is
 * destroyed, and a reload cannot bring it back because there is nowhere for it
 * to have been kept.
 *
 * Copy and download are offered because an operator has to get the value
 * somewhere. Both act on what is already on screen; neither leaves a copy
 * behind in the application.
 */
@Component({
  selector: 'dp-one-time-secret',
  imports: [Button, Icon],
  template: `
    <div class="secret" role="group" [attr.aria-label]="label()">
      <p class="warning">
        <dp-icon name="info" />
        <span>{{ warning() }}</span>
      </p>

      @if (values().length === 1) {
        <p class="value dp-mono" data-testid="secret-value">{{ values()[0] }}</p>
      } @else {
        <ul class="values">
          @for (value of values(); track value) {
            <li class="dp-mono" data-testid="secret-value">{{ value }}</li>
          }
        </ul>
      }

      <div class="actions">
        <button dpButton variant="secondary" type="button" (click)="copy()">
          {{ copyLabel() }}
        </button>

        @if (downloadName()) {
          <button dpButton variant="ghost" type="button" (click)="download()">Download</button>
        }
      </div>

      <!-- Announced rather than only shown, so a screen reader learns whether
           the copy actually happened. -->
      <p class="status" role="status">{{ status() }}</p>
    </div>
  `,
  styles: `
    .secret {
      display: grid;
      gap: 0.75rem;
      padding: 0.875rem;
      background: var(--dp-surface-inset);
      border: 1px solid var(--dp-line);
      border-radius: var(--dp-radius-md);
    }

    .warning {
      display: flex;
      gap: 0.5rem;
      align-items: start;
      margin: 0;
      color: var(--dp-status-warn);
      font-size: var(--dp-text-body);
    }

    .value,
    .values li {
      margin: 0;
      padding: 0.5rem 0.625rem;
      overflow-wrap: anywhere;
      background: var(--dp-surface);
      border: 1px solid var(--dp-line);
      border-radius: var(--dp-radius-sm);
    }

    .values {
      display: grid;
      gap: 0.375rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .actions {
      display: flex;
      gap: 0.5rem;
    }

    .status {
      margin: 0;
      min-block-size: 1rem;
      color: var(--dp-fg-muted);
      font-size: var(--dp-text-label);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OneTimeSecret implements OnDestroy {
  readonly values = input.required<readonly string[]>();
  readonly label = input.required<string>();
  readonly warning = input('Copy this now. It will not be shown again.');

  /** Offers a download under this file name. Omit to hide the button. */
  readonly downloadName = input<string>();

  private readonly copied = signal(false);

  protected readonly status = signal('');

  protected readonly copyLabel = computed(() =>
    this.copied() ? 'Copied' : this.values().length > 1 ? 'Copy all' : 'Copy',
  );

  /**
   * Copies to the clipboard, and says so only if it worked.
   *
   * A browser can refuse this — no permission, no secure context. Reporting
   * success anyway would let an operator navigate away believing they had
   * saved something they had not.
   */
  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.text());

      this.copied.set(true);
      this.status.set('Copied to the clipboard.');
    } catch {
      this.copied.set(false);
      this.status.set('The browser refused to copy. Select the value and copy it manually.');
    }
  }

  /** Writes the value to a local file. Nothing leaves the browser. */
  protected download(): void {
    const blob = new Blob([`${this.text()}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = this.downloadName() ?? 'dockplane-secret.txt';
    link.click();

    URL.revokeObjectURL(url);
    this.status.set('Saved to your downloads.');
  }

  ngOnDestroy(): void {
    // The value came in as an input, so the owner clears it; what this
    // component held on its own goes now.
    this.status.set('');
    this.copied.set(false);
  }

  private text(): string {
    return this.values().join('\n');
  }
}
