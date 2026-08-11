import { Component, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ConfirmDialog } from './confirm-dialog';

@Component({
  imports: [ConfirmDialog],
  template: `
    <dp-confirm-dialog
      heading="Restart nextcloud?"
      description="The workload is briefly unavailable."
      confirmLabel="Restart container"
      [destructive]="destructive"
      [details]="[{ label: 'Host', value: 'docker-01' }]"
      (confirmed)="confirmed = true"
    />
  `,
})
class Host {
  readonly dialog = viewChild.required(ConfirmDialog);
  destructive = false;
  confirmed = false;
}

describe('ConfirmDialog', () => {
  const render = async (destructive = false) => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.destructive = destructive;
    fixture.detectChanges();
    return fixture;
  };

  const buttons = (fixture: { nativeElement: unknown }) =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('footer button'));

  it('names the action instead of using a generic label', async () => {
    const fixture = await render();

    expect(buttons(fixture).at(-1)?.textContent?.trim()).toBe('Restart container');
    expect(buttons(fixture).at(0)?.textContent?.trim()).toBe('Cancel');
  });

  it('labels the dialog with its own heading', async () => {
    const fixture = await render();
    const dialog = (fixture.nativeElement as HTMLElement).querySelector('dialog');

    expect(dialog?.getAttribute('aria-labelledby')).toBe('confirm-title');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('#confirm-title')?.textContent,
    ).toContain('Restart nextcloud?');
  });

  it('puts cancel before the confirming action so the dangerous button is not the default', async () => {
    const fixture = await render(true);
    const order = buttons(fixture).map((button) => button.textContent?.trim());

    expect(order[0]).toBe('Cancel');
    expect(buttons(fixture).at(-1)?.classList.contains('dp-button--danger')).toBe(true);
  });

  it('states the consequence for a destructive action', async () => {
    const fixture = await render(true);

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('This cannot be undone.');
  });

  it('omits the consequence for an ordinary operational action', async () => {
    const fixture = await render(false);

    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('cannot be undone');
  });

  it('emits only when the confirming action is used', async () => {
    const fixture = await render();
    buttons(fixture).at(-1)?.dispatchEvent(new Event('click'));
    fixture.detectChanges();

    expect(fixture.componentInstance.confirmed).toBe(true);
  });
});
