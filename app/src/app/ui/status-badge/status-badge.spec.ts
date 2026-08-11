import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { StatusTone } from '../../domain/status';
import { StatusBadge } from './status-badge';

@Component({
  imports: [StatusBadge],
  template: `<dp-status-badge [tone]="tone" [label]="label" />`,
})
class Host {
  tone: StatusTone = 'ok';
  label = 'Healthy';
}

describe('StatusBadge', () => {
  const render = async (tone: StatusTone, label: string) => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.tone = tone;
    fixture.componentInstance.label = label;
    fixture.detectChanges();
    return fixture;
  };

  it('always renders the textual label', async () => {
    const fixture = await render('critical', 'Offline');

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Offline');
  });

  it('carries a tone class so the glyph shape can differ per state', async () => {
    for (const tone of ['ok', 'warn', 'critical', 'info', 'neutral'] as StatusTone[]) {
      const fixture = await render(tone, 'State');
      const badge = (fixture.nativeElement as HTMLElement).querySelector('dp-status-badge');

      expect(badge?.classList.contains(`tone-${tone}`)).toBe(true);
    }
  });

  it('hides the decorative glyph from assistive technology', async () => {
    const fixture = await render('warn', 'Warning');
    const glyph = (fixture.nativeElement as HTMLElement).querySelector('.glyph');

    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  });
});
