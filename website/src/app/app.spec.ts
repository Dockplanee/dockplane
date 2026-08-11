import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes)],
    }).compileComponents();
  });

  function render() {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    return fixture;
  }

  it('places a skip link ahead of the header', () => {
    const element = render().nativeElement as HTMLElement;
    const skipLink = element.querySelector<HTMLAnchorElement>('a.skip-link');

    expect(skipLink).toBeTruthy();
    expect(element.firstElementChild).toBe(skipLink);
  });

  it('resolves the skip link against the page rather than the document base', () => {
    const element = render().nativeElement as HTMLElement;
    const href = element.querySelector('a.skip-link')?.getAttribute('href');

    expect(href?.startsWith('/')).toBe(true);
    expect(href?.endsWith('#main-content')).toBe(true);
  });

  it('moves focus to the main landmark when the skip link is used', () => {
    const fixture = render();
    const element = fixture.nativeElement as HTMLElement;
    const skipLink = element.querySelector<HTMLAnchorElement>('a.skip-link');

    skipLink?.click();

    expect(document.activeElement).toBe(element.querySelector('main'));
  });

  it('exposes a main landmark that the skip link targets', () => {
    const element = render().nativeElement as HTMLElement;
    const main = element.querySelector('main');

    expect(main?.id).toBe('main-content');
    expect(main?.getAttribute('tabindex')).toBe('-1');
  });

  it('renders the site header and footer around the routed content', () => {
    const element = render().nativeElement as HTMLElement;

    expect(element.querySelector('dp-site-header')).toBeTruthy();
    expect(element.querySelector('dp-site-footer')).toBeTruthy();
    expect(element.querySelector('main router-outlet')).toBeTruthy();
  });
});
