import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { Icon } from '../icon/icon';

export interface RowAction {
  readonly id: string;
  readonly label: string;
  /** Disabled entries stay visible so the offered set does not shift silently. */
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  /** Explains why an entry is unavailable. */
  readonly hint?: string;
}

/**
 * Per-row action menu.
 *
 * Keyboard operable and closed by Escape or by clicking outside. Actions that
 * the operator lacks permission for are shown disabled with a reason rather
 * than removed, so the available set does not change shape between rows.
 *
 * The menu opens in the top layer. A table scrolls sideways, and a horizontal
 * scroll container clips vertically as well, so a menu positioned inside the
 * row was cut off at the table's edge: the entries below the cut were painted
 * but not clickable, and the last entry of a row menu is usually the
 * destructive one.
 */
@Component({
  selector: 'dp-row-menu',
  imports: [Icon],
  template: `
    <button
      #trigger
      type="button"
      class="trigger"
      [attr.aria-label]="'Actions for ' + subject()"
      [attr.aria-expanded]="open()"
      aria-haspopup="menu"
      (click)="toggle()"
      (keydown.arrowdown)="openMenu($event)"
    >
      <dp-icon name="more" />
    </button>

    <div
      #menu
      class="menu"
      popover="manual"
      role="menu"
      [attr.aria-label]="'Actions for ' + subject()"
    >
      @for (action of actions(); track action.id) {
        <button
          type="button"
          role="menuitem"
          [class.destructive]="action.destructive"
          [disabled]="action.disabled"
          [attr.title]="action.disabled ? action.hint : null"
          (click)="choose(action)"
        >
          {{ action.label }}
        </button>
      }
    </div>
  `,
  styles: `
    :host {
      position: relative;
      display: inline-flex;
    }

    .trigger {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.75rem;
      height: 1.75rem;
      border: 1px solid transparent;
      border-radius: var(--dp-radius-sm);
      background: none;
      color: var(--dp-fg-muted);
      cursor: pointer;
    }

    .trigger:hover {
      color: var(--dp-fg);
      border-color: var(--dp-line);
      background-color: var(--dp-surface);
    }

    .menu {
      position: fixed;
      inset: auto;
      margin: 0;
      min-width: 11rem;
      padding: 0.25rem;
      border: 1px solid var(--dp-line-strong);
      border-radius: var(--dp-radius-md);
      background-color: var(--dp-surface);
      box-shadow: 0 8px 24px rgb(0 0 0 / 0.28);
    }

    /* Shown where the top layer is unavailable and the fallback opened it. */
    .menu[data-open] {
      display: block;
    }

    .menu button {
      display: block;
      width: 100%;
      padding: 0.4375rem 0.5rem;
      border: 0;
      border-radius: var(--dp-radius-sm);
      background: none;
      color: var(--dp-fg);
      font: inherit;
      font-size: 0.8125rem;
      text-align: left;
      cursor: pointer;
    }

    .menu button:hover:not(:disabled) {
      background-color: var(--dp-surface-alt);
    }

    .menu button:disabled {
      color: var(--dp-fg-muted);
      cursor: not-allowed;
    }

    .menu button.destructive:not(:disabled) {
      color: var(--dp-status-critical);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(keydown.escape)': 'dismiss()',
    // An open menu is placed against the trigger, so it closes rather than
    // hanging in place when the viewport changes underneath it.
    '(window:resize)': 'dismiss()',
  },
})
export class RowMenu {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly menu = viewChild.required<ElementRef<HTMLElement>>('menu');

  constructor() {
    // A row that disappears while its menu is open must not leave the listener.
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('scroll', this.onScroll, true);
    });
  }

  readonly actions = input.required<readonly RowAction[]>();

  /** Names the row this menu belongs to, for the accessible name. */
  readonly subject = input.required<string>();

  readonly selected = output<string>();

  protected readonly open = signal(false);
  protected readonly hasActions = computed(() => this.actions().length > 0);

  /** Distance kept from the trigger and from the edges of the viewport. */
  private readonly gap = 4;
  private readonly margin = 8;

  protected toggle(): void {
    if (this.open()) {
      this.close();

      return;
    }

    this.show();
  }

  protected openMenu(event: Event): void {
    event.preventDefault();

    if (!this.open()) {
      this.show();
    }

    this.menu().nativeElement.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  protected choose(action: RowAction): void {
    if (action.disabled) {
      return;
    }

    this.close();
    this.selected.emit(action.id);
  }

  protected dismiss(): void {
    if (this.open()) {
      this.close();
      this.trigger().nativeElement.focus();
    }
  }

  protected onDocumentClick(event: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) {
      this.close();
    }
  }

  private show(): void {
    const element = this.menu().nativeElement;

    /*
     * Scrolling anything, including the table's own sideways scroll, moves the
     * row away from the menu. Scroll events do not bubble, so this is the
     * capture phase on the document, and only while a menu is open.
     */
    document.addEventListener('scroll', this.onScroll, true);

    /*
     * The top layer is what lifts the menu out of the table's scroll
     * container. Not every environment implements it — a test renderer
     * typically does not — so the menu still opens there rather than the call
     * throwing and taking the action it was offering with it.
     */
    if (typeof element.showPopover === 'function') {
      element.showPopover();
    } else {
      element.setAttribute('data-open', '');
    }

    this.open.set(true);
    this.place(element);
  }

  private close(): void {
    const element = this.menu().nativeElement;

    document.removeEventListener('scroll', this.onScroll, true);

    if (typeof element.hidePopover === 'function' && element.matches(':popover-open')) {
      element.hidePopover();
    }

    element.removeAttribute('data-open');
    this.open.set(false);
  }

  private readonly onScroll = (): void => {
    this.close();
  };

  /** Anchors the menu to the trigger, flipping above it near the bottom edge. */
  private place(element: HTMLElement): void {
    if (typeof element.getBoundingClientRect !== 'function') {
      return;
    }

    const anchor = this.trigger().nativeElement.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = element;

    const left = Math.min(
      Math.max(this.margin, anchor.right - width),
      Math.max(this.margin, window.innerWidth - width - this.margin),
    );

    const below = anchor.bottom + this.gap;
    const fits = below + height + this.margin <= window.innerHeight;

    element.style.left = `${left}px`;
    element.style.top = `${fits ? below : Math.max(this.margin, anchor.top - this.gap - height)}px`;
  }

}
