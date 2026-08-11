import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { checkAccessibility } from '../../../testing/accessibility';
import { routes } from '../../app.routes';
import { EXTERNAL_LINKS } from '../../core/site.config';
import { SiteFooter } from './site-footer';

describe('SiteFooter', () => {
  let fixture: ComponentFixture<SiteFooter>;
  let element: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SiteFooter],
      providers: [provideRouter(routes)],
    }).compileComponents();

    fixture = TestBed.createComponent(SiteFooter);
    fixture.detectChanges();
    await fixture.whenStable();
    element = fixture.nativeElement as HTMLElement;
  });

  it('has no accessibility violations', async () => {
    const { violations } = await checkAccessibility(fixture);

    expect(violations.join('\n\n')).toBe('');
  });

  it('links only to destinations that exist', () => {
    const configured = Object.values(EXTERNAL_LINKS).filter(
      (value): value is string => value !== null,
    );
    const links = Array.from(element.querySelectorAll('a'));

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const href = link.getAttribute('href') ?? '';
      const internal = href.startsWith('/');
      const external = configured.some((value) => href === value);

      expect(internal || external).toBe(true);
    }
  });

  it('opens external destinations without exposing the opener', () => {
    const external = Array.from(element.querySelectorAll('a')).filter((link) =>
      (link.getAttribute('href') ?? '').startsWith('http'),
    );

    for (const link of external) {
      expect(link.getAttribute('rel')).toContain('noopener');
    }
  });

  it('states the current development status', () => {
    expect(element.querySelector('.footer__status')?.textContent).toContain('active development');
  });
});
