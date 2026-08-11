import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  booleanAttribute,
  input,
  output,
  viewChild,
} from '@angular/core';

import { Button } from '../button';

export interface ConfirmDetail {
  readonly label: string;
  readonly value: string;
}

/**
 * Confirmation for operational and destructive actions.
 *
 * Built on the native dialog element, which traps focus, closes on Escape and
 * restores focus to the control that opened it. The confirming action is never
 * focused on open, so a destructive operation cannot be triggered by a stray
 * Enter key.
 */
@Component({
  selector: 'dp-confirm-dialog',
  imports: [Button],
  template: `
    <dialog #dialog aria-labelledby="confirm-title" (cancel)="dismissed.emit()">
      <h2 id="confirm-title">{{ heading() }}</h2>
      <p class="description">{{ description() }}</p>

      @if (details().length > 0) {
        <dl class="details">
          @for (detail of details(); track detail.label) {
            <div>
              <dt>{{ detail.label }}</dt>
              <dd>{{ detail.value }}</dd>
            </div>
          }
        </dl>
      }

      @if (destructive()) {
        <p class="consequence">{{ consequence() }}</p>
      }

      <footer>
        <button type="button" dpButton variant="secondary" [disabled]="pending()" (click)="close()">
          Cancel
        </button>
        <button
          type="button"
          dpButton
          [variant]="destructive() ? 'danger' : 'primary'"
          [disabled]="pending()"
          (click)="confirmed.emit()"
        >
          {{ pending() ? 'Working…' : confirmLabel() }}
        </button>
      </footer>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(28rem, calc(100vw - 2rem));
      padding: 1.25rem;
      border: 1px solid var(--dp-line-strong);
      border-radius: var(--dp-radius-lg);
      background-color: var(--dp-surface);
      color: var(--dp-fg);
    }

    h2 {
      font-size: 1rem;
    }

    .description {
      margin-top: 0.5rem;
      color: var(--dp-fg-muted);
      font-size: 0.8125rem;
      line-height: 1.6;
    }

    .details {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.5rem;
      margin-top: 1rem;
      padding: 0.75rem;
      border: 1px solid var(--dp-line);
      border-radius: var(--dp-radius-sm);
      background-color: var(--dp-surface-inset);
    }

    .details div {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      font-size: 0.8125rem;
    }

    dt {
      color: var(--dp-fg-muted);
    }

    dd {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      text-align: right;
    }

    .consequence {
      margin-top: 0.875rem;
      padding: 0.625rem 0.75rem;
      border-radius: var(--dp-radius-sm);
      background-color: var(--dp-status-critical-soft);
      color: var(--dp-status-critical);
      font-size: 0.8125rem;
      line-height: 1.5;
    }

    footer {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      margin-top: 1.25rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialog {
  readonly heading = input.required<string>();
  readonly description = input.required<string>();
  readonly confirmLabel = input.required<string>();
  readonly details = input<readonly ConfirmDetail[]>([]);
  readonly destructive = input(false, { transform: booleanAttribute });
  readonly consequence = input('This cannot be undone.');
  readonly pending = input(false, { transform: booleanAttribute });

  readonly confirmed = output<void>();
  readonly dismissed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  open(): void {
    const element = this.dialog().nativeElement;

    if (element.open) {
      return;
    }

    /*
     * showModal is what traps focus and dims the page. Not every environment
     * implements it — a test renderer typically does not — so the dialog is
     * still opened there rather than the call throwing and taking the action
     * it was confirming with it.
     */
    if (typeof element.showModal === 'function') {
      element.showModal();
    } else {
      element.setAttribute('open', '');
    }

    // Cancel receives focus so the confirming action is never the default.
    element.querySelector<HTMLButtonElement>('footer button')?.focus();
  }

  close(): void {
    const element = this.dialog().nativeElement;

    if (!element.open) {
      return;
    }

    if (typeof element.close === 'function') {
      element.close();
    } else {
      element.removeAttribute('open');
    }

    this.dismissed.emit();
  }
}
