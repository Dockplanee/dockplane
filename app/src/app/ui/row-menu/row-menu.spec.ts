import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { RowAction, RowMenu } from './row-menu';

const ACTIONS: readonly RowAction[] = [
  { id: 'inspect', label: 'Inspect agent' },
  { id: 'revoke', label: 'Revoke agent', destructive: true },
];

@Component({
  imports: [RowMenu],
  template: `
    <div class="scroll">
      <dp-row-menu [actions]="actions()" subject="agent 263309dc" (selected)="chosen.set($event)" />
    </div>
  `,
  styles: `
    .scroll {
      overflow-x: auto;
    }
  `,
})
class Host {
  readonly actions = signal(ACTIONS);
  readonly chosen = signal<string | null>(null);
}

async function render() {
  await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();

  const element = fixture.nativeElement as HTMLElement;

  return {
    fixture,
    element,
    trigger: element.querySelector<HTMLButtonElement>('.trigger')!,
    menu: () => element.querySelector<HTMLElement>('.menu')!,
    items: () => Array.from(element.querySelectorAll<HTMLButtonElement>('.menu button')),
  };
}

describe('RowMenu', () => {
  /*
   * The menu sits inside a table that scrolls sideways, and a horizontal
   * scroll container clips vertically too. Rendering in the top layer is what
   * keeps the entries below the table's edge clickable rather than merely
   * visible — the last entry of a row menu is usually the destructive one.
   */
  it('renders the menu in the top layer so a scroll container cannot clip it', async () => {
    const { menu } = await render();

    expect(menu().getAttribute('popover')).toBe('manual');
  });

  it('opens on the trigger and offers every action', async () => {
    const { fixture, trigger, items } = await render();

    trigger.click();
    fixture.detectChanges();

    expect(items().map((item) => item.textContent?.trim())).toEqual([
      'Inspect agent',
      'Revoke agent',
    ]);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('moves focus into the menu when it is opened from the keyboard', async () => {
    const { fixture, trigger, items } = await render();

    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();

    expect(document.activeElement).toBe(items()[0]);
  });

  it('reports the chosen action and closes', async () => {
    const { fixture, element, trigger, items } = await render();
    const host = fixture.componentInstance;

    trigger.click();
    fixture.detectChanges();

    items()[1].click();
    fixture.detectChanges();

    expect(host.chosen()).toBe('revoke');
    expect(element.querySelector('.menu')?.hasAttribute('data-open')).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape and gives the trigger its focus back', async () => {
    const { fixture, element, trigger } = await render();

    trigger.click();
    fixture.detectChanges();

    element
      .querySelector('dp-row-menu')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  /*
   * An open menu is placed against its row. Scrolling moves the row and not
   * the menu, and scroll events do not bubble, so the listener is a capturing
   * one on the document.
   */
  it('closes when anything scrolls underneath it', async () => {
    const { fixture, element, trigger } = await render();

    trigger.click();
    fixture.detectChanges();

    element.querySelector('.scroll')!.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
