import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { CodeBlock } from './code-block/code-block';
import { Logo } from './logo/logo';
import { StatusBadge, StatusTone } from './status-badge/status-badge';

describe('Logo', () => {
  it('reads as the wordmark, with the symbol hidden from assistive technology', async () => {
    const fixture = TestBed.createComponent(Logo);
    fixture.detectChanges();
    await fixture.whenStable();

    const element = fixture.nativeElement as HTMLElement;

    expect(element.textContent?.replace(/\s+/g, '')).toBe('Dockplane');
    expect(element.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('carries its own accessible name when the wordmark is omitted', async () => {
    const fixture = TestBed.createComponent(Logo);
    fixture.componentRef.setInput('variant', 'mark');
    fixture.detectChanges();
    await fixture.whenStable();

    const svg = (fixture.nativeElement as HTMLElement).querySelector('svg');

    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe('Dockplane');
    expect(svg?.hasAttribute('aria-hidden')).toBe(false);
  });
});

describe('StatusBadge', () => {
  const tones: StatusTone[] = ['ok', 'warn', 'critical', 'info', 'neutral'];

  it('always pairs the indicator with a text label', async () => {
    for (const tone of tones) {
      const fixture = TestBed.createComponent(StatusBadge);
      fixture.componentRef.setInput('tone', tone);
      fixture.componentRef.setInput('label', 'Healthy');
      fixture.detectChanges();
      await fixture.whenStable();

      const element = fixture.nativeElement as HTMLElement;

      expect(element.querySelector('.badge__label')?.textContent?.trim()).toBe('Healthy');
      expect(element.querySelector('.badge__glyph')?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('distinguishes tones through a class rather than through colour alone', async () => {
    const fixture = TestBed.createComponent(StatusBadge);
    fixture.componentRef.setInput('tone', 'warn');
    fixture.componentRef.setInput('label', 'Warning');
    fixture.detectChanges();
    await fixture.whenStable();

    expect((fixture.nativeElement as HTMLElement).className).toContain('badge--warn');
  });
});

@Component({
  imports: [CodeBlock],
  template: `<dp-code-block [lines]="lines" label="Example capabilities" />`,
})
class CodeBlockHost {
  readonly lines = ['container.list', 'container.restart'];
}

describe('CodeBlock', () => {
  it('keeps long lines reachable by keyboard', async () => {
    const fixture = TestBed.createComponent(CodeBlockHost);
    fixture.detectChanges();
    await fixture.whenStable();

    const block = (fixture.nativeElement as HTMLElement).querySelector('pre');

    expect(block?.getAttribute('tabindex')).toBe('0');
    expect(block?.getAttribute('aria-label')).toBe('Example capabilities');
    expect(block?.textContent).toContain('container.restart');
  });
});
