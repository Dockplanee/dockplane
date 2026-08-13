import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  booleanAttribute,
  computed,
  input,
  output,
  signal,
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

      <!--
        Typing the name is for the operations somebody must not perform by
        reflex. It is a deliberate pause, not a security control: whoever may
        do this may do it, and the point is that they meant to.
      -->
      @if (confirmationPhrase(); as phrase) {
        <label class="phrase">
          <span>Type <strong>{{ phrase }}</strong> to confirm.</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            [value]="typed()"
            (input)="typed.set($any($event.target).value)"
          />
        </label>
      }

      <footer>
        <button type="button" dpButton variant="secondary" [disabled]="pending()" (click)="close()">
          Cancel
        </button>
        <button
          type="button"
          dpButton
          [variant]="destructive() ? 'danger' : 'primary'"
          [disabled]="pending() || !phraseMatches()"
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

    .phrase {
      display: block;
      margin-top: 0.875rem;
      font-size: 0.8125rem;
    }

    .phrase input {
      width: 100%;
      margin-top: 0.375rem;
      padding: 0.5rem;
      border: 1px solid var(--dp-line-strong);
      border-radius: var(--dp-radius-sm);
      background-color: var(--dp-surface-inset);
      color: var(--dp-fg);
      font-family: var(--font-mono);
      font-size: 0.8125rem;
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
  /**
   * What has to be typed before the action may be taken.
   *
   * Absent for the ordinary case. Set for the ones where a mistaken click
   * costs something that cannot be clicked back.
   */
  readonly confirmationPhrase = input<string | undefined>(undefined);

  readonly confirmed = output<void>();
  readonly dismissed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly typed = signal('');

  /** Whether the confirming action may be taken at all. */
  protected readonly phraseMatches = computed(() => {
    const phrase = this.confirmationPhrase();

    return !phrase || this.typed().trim() === phrase;
  });

  open(): void {
    const element = this.dialog().nativeElement;

    // A dialog that opened before keeps nothing from last time.
    this.typed.set('');

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
