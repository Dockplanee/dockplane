import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { routes } from '../../app.routes';
import { PRIMARY_NAV } from '../../core/navigation';
import { checkAccessibility } from '../../../testing/accessibility';
import { SiteHeader } from './site-header';

describe('SiteHeader', () => {
  let fixture: ComponentFixture<SiteHeader>;
  let element: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SiteHeader],
      providers: [provideRouter(routes)],
    }).compileComponents();

    fixture = TestBed.createComponent(SiteHeader);
    fixture.detectChanges();
    await fixture.whenStable();
    element = fixture.nativeElement as HTMLElement;
  });

  function menuButton(): HTMLButtonElement {
    return element.querySelector<HTMLButtonElement>('.header__menu-button')!;
  }

  function menuPanel(): HTMLElement {
    return element.querySelector<HTMLElement>('#site-menu')!;
  }

  it('has no accessibility violations', async () => {
    const { violations } = await checkAccessibility(fixture);

    expect(violations.join('\n\n')).toBe('');
  });

  it('renders every primary navigation entry', () => {
    const labels = Array.from(element.querySelectorAll('.header__nav-link')).map((link) =>
      link.textContent?.trim(),
    );

    expect(labels).toEqual(PRIMARY_NAV.map((link) => link.label));
  });

  it('labels the branding link so it is not announced as the mark alone', () => {
    const brand = element.querySelector('.header__brand');

    expect(brand?.textContent?.trim()).toContain('Dockplane');
  });

  it('starts with the mobile navigation collapsed', () => {
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(menuPanel().hasAttribute('hidden')).toBe(true);
  });

  it('reflects the open state on the control that owns the panel', () => {
    menuButton().click();
    fixture.detectChanges();

    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
    expect(menuPanel().hasAttribute('hidden')).toBe(false);
    expect(menuButton().getAttribute('aria-controls')).toBe(menuPanel().id);
  });

  it('closes the panel when a destination is chosen', () => {
    menuButton().click();
    fixture.detectChanges();

    menuPanel().querySelector<HTMLAnchorElement>('.header__panel-link')!.click();
    fixture.detectChanges();

    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape and returns focus to the menu button', () => {
    menuButton().click();
    fixture.detectChanges();

    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menuButton());
  });

  it('offers a theme control with a descriptive name', () => {
    const toggle = element.querySelector('dp-theme-toggle button');

    expect(toggle?.getAttribute('aria-label')).toMatch(/switch to (light|dark) theme/i);
  });
});
