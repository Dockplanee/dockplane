import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  viewChild,
} from '@angular/core';

import { Button } from '../../ui/button';
import { ENVIRONMENT_CHANGE_LABELS } from './revision-diff';
import { StackApply } from './stack-apply';
import { StackStore } from './stack-store';

/**
 * The review shown before a revision is applied.
 *
 * Applying a revision recreates every container of a stack, so this is the last
 * place somebody can see what it changes. The consequences are stated in words
 * every time — the brief interruption, and that volumes are kept — because they
 * are the same whichever direction the revision goes.
 *
 * Built on the native dialog element, which traps focus, closes on Escape and
 * returns focus to the control that opened it. Cancel is focused on open, so a
 * stray Enter cannot deploy anything.
 */
@Component({
  selector: 'dp-stack-apply-dialog',
  imports: [Button],
  template: `
    <dialog #dialog aria-labelledby="apply-title" (cancel)="apply.cancel()">
      <h2 id="apply-title">{{ apply.heading() }}</h2>
      <p class="description">{{ apply.description() }}</p>

      <dl class="details">
        <div>
          <dt>Stack</dt>
          <dd>{{ store.stack()?.name }}</dd>
        </div>
        <div>
          <dt>Host</dt>
          <dd>{{ store.stack()?.hostname }}</dd>
        </div>
        <div>
          <dt>Running</dt>
          <dd>
            {{
              store.stack()?.runningRevision
                ? '#' + store.stack()!.runningRevision!.number
                : 'Not deployed'
            }}
          </dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{{ apply.target() ? '#' + apply.target()!.number : '' }}</dd>
        </div>
        <div>
          <dt>Services</dt>
          <dd>{{ serviceCount() }}</dd>
        </div>
      </dl>

      @if (apply.diff(); as diff) {
        <section class="review" aria-labelledby="apply-review">
          <h3 id="apply-review">What changes</h3>

          @if (diff.identical) {
            <p class="review__empty">
              These two revisions have the same Compose file and the same environment.
            </p>
          }

          @if (diff.environment.length > 0) {
            <ul class="environment">
              @for (entry of diff.environment; track entry.key) {
                <li>
                  <span class="environment__kind">{{ kindLabel(entry.kind) }}</span>
                  <code class="dp-mono">{{ entry.key }}</code>
                  @if (entry.kind === 'changed') {
                    <span class="environment__values dp-mono"
                      >{{ entry.from }} → {{ entry.to }}</span
                    >
                  }
                </li>
              }
            </ul>
          }

          @if (composeChanges().length > 0) {
            <div class="diff" tabindex="0" role="group" aria-label="Compose file changes">
              @for (line of composeChanges(); track $index) {
                <div class="diff__line" [class]="'diff__line--' + line.kind">
                  <span class="diff__mark" aria-hidden="true">{{ mark(line.kind) }}</span>
                  <span class="dp-sr-only">{{ line.kind }}</span>
                  <span class="diff__text dp-mono">{{ line.text }}</span>
                </div>
              }
            </div>
          }
        </section>
      } @else if (apply.diffFailed()) {
        <p class="review__empty">
          What changes between these revisions could not be loaded. The revision can still be
          applied.
        </p>
      } @else if (!apply.canReview()) {
        <p class="review__empty">
          Showing what changes needs permission to read this stack's configuration.
        </p>
      }

      <footer>
        <button
          type="button"
          dpButton
          variant="secondary"
          [disabled]="apply.busy()"
          (click)="apply.cancel()"
        >
          Cancel
        </button>
        <button
          type="button"
          dpButton
          variant="primary"
          [disabled]="apply.busy()"
          (click)="apply.confirm()"
        >
          {{ apply.busy() ? 'Working…' : apply.label() }}
        </button>
      </footer>
    </dialog>
  `,
  styleUrl: './stack-apply-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StackApplyDialog {
  protected readonly apply = inject(StackApply);
  protected readonly store = inject(StackStore);

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly kindLabel = (kind: keyof typeof ENVIRONMENT_CHANGE_LABELS) =>
    ENVIRONMENT_CHANGE_LABELS[kind];

  constructor() {
    effect(() => (this.apply.target() ? this.open() : this.close()));
  }

  /** The lines that differ, with a little of what surrounds them. */
  protected composeChanges() {
    const lines = this.apply.diff()?.compose ?? [];
    const shown: { kind: string; text: string }[] = [];

    lines.forEach((line, index) => {
      const near = lines
        .slice(Math.max(0, index - 2), index + 3)
        .some((other) => other.kind !== 'context');

      if (line.kind !== 'context' || near) {
        shown.push(line);
      }
    });

    return shown;
  }

  protected serviceCount(): string {
    const summary = this.apply.target()?.summary;

    return summary ? String(summary.services.length) : '—';
  }

  protected mark(kind: string): string {
    return kind === 'added' ? '+' : kind === 'removed' ? '−' : ' ';
  }

  private open(): void {
    const element = this.dialog().nativeElement;

    if (element.open) {
      return;
    }

    /*
     * showModal is what traps focus and dims the page. Not every environment
     * implements it — a test renderer typically does not — so the dialog is
     * still opened there rather than the call throwing and taking the action it
     * was confirming with it.
     */
    if (typeof element.showModal === 'function') {
      element.showModal();
    } else {
      element.setAttribute('open', '');
    }

    element.querySelector<HTMLButtonElement>('footer button')?.focus();
  }

  private close(): void {
    const element = this.dialog().nativeElement;

    if (!element.open) {
      return;
    }

    if (typeof element.close === 'function') {
      element.close();
    } else {
      element.removeAttribute('open');
    }
  }
}
