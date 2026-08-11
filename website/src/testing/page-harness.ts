import { Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { routes } from '../app/app.routes';

/** Renders a page component with the real route table available for links. */
export async function renderPage<T>(component: Type<T>): Promise<ComponentFixture<T>> {
  await TestBed.configureTestingModule({
    imports: [component as Type<unknown>],
    providers: [provideRouter(routes)],
  }).compileComponents();

  const fixture = TestBed.createComponent(component);
  fixture.detectChanges();
  await fixture.whenStable();

  return fixture;
}

/** Every anchor a page renders, so link integrity can be asserted. */
export function anchors(fixture: ComponentFixture<unknown>): HTMLAnchorElement[] {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('a'));
}

/** Heading levels in document order, used to detect skipped levels. */
export function headingLevels(fixture: ComponentFixture<unknown>): number[] {
  return Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll('h1, h2, h3, h4, h5, h6'),
  ).map((heading) => Number(heading.tagName.slice(1)));
}
