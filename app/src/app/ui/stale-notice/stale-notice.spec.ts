import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { StaleNotice } from './stale-notice';

@Component({
  imports: [StaleNotice],
  template: `<dp-stale-notice [lastSeen]="lastSeen" />`,
})
class Host {
  lastSeen = new Date(Date.now() - 8 * 60_000).toISOString();
}

describe('StaleNotice', () => {
  it('names the age of the last report instead of presenting values as live', async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('not reporting');
    expect(text).toContain('last report');
    expect(text).toContain('8m ago');
  });

  it('marks the timestamp up as a machine-readable time', async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    const time = (fixture.nativeElement as HTMLElement).querySelector('time');
    expect(time?.getAttribute('datetime')).toBeTruthy();
  });
});
