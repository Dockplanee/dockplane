import { Type } from '@angular/core';

import { checkAccessibility } from '../../testing/accessibility';
import { anchors, headingLevels, renderPage } from '../../testing/page-harness';
import { Changelog } from './changelog/changelog';
import { Docs } from './docs/docs';
import { Features } from './features/features';
import { Home } from './home/home';
import { NotFound } from './not-found/not-found';
import { Product } from './product/product';
import { Security } from './security/security';

const PAGES: [name: string, component: Type<unknown>, expectsH1: boolean][] = [
  ['home', Home, true],
  ['product', Product, true],
  ['features', Features, true],
  ['security', Security, true],
  ['docs', Docs, true],
  ['changelog', Changelog, true],
  ['not found', NotFound, true],
];

describe('public pages', () => {
  for (const [name, component, expectsH1] of PAGES) {
    describe(name, () => {
      /*
       * The numbers beside the section eyebrows.
       *
       * Twice now a section has been inserted into a page whose later sections
       * carried hand-written numbers, and the page went out with two sections
       * claiming the same position. A reader counts them; nothing else did.
       */
      it('numbers its sections once each, in order', async () => {
        const fixture = await renderPage(component);
        const rendered: string[] = [
          ...fixture.nativeElement.querySelectorAll('.header__index'),
        ].map((element: Element) => element.textContent?.trim() ?? '');

        // A page with an inline index writes it as "03 — Authorization".
        const inline: string[] = [...fixture.nativeElement.querySelectorAll('.stack__index')]
          .map((element: Element) => (element.textContent ?? '').trim().slice(0, 2))
          .filter((value: string) => /^\d\d$/.test(value));

        const indices = [...rendered, ...inline].filter((value) => /^\d+$/.test(value));

        expect(new Set(indices).size, `${name} repeats a section number`).toBe(indices.length);

        const numbers = indices.map(Number).sort((a, b) => a - b);
        expect(numbers, `${name} skips a section number`).toEqual(
          numbers.map((_, position) => position + 1),
        );
      });

      it('has no accessibility violations', async () => {
        const fixture = await renderPage(component);
        const { violations } = await checkAccessibility(fixture);

        expect(violations.join('\n\n')).toBe('');
      });

      it('starts at a single level-one heading', async () => {
        const fixture = await renderPage(component);
        const levels = headingLevels(fixture);

        if (expectsH1) {
          expect(levels.filter((level) => level === 1).length).toBe(1);
          expect(levels[0]).toBe(1);
        }
      });

      it('does not skip heading levels', async () => {
        const fixture = await renderPage(component);
        const levels = headingLevels(fixture);

        for (let index = 1; index < levels.length; index += 1) {
          expect(levels[index] - levels[index - 1]).toBeLessThanOrEqual(1);
        }
      });

      it('renders no placeholder or empty links', async () => {
        const fixture = await renderPage(component);

        for (const anchor of anchors(fixture)) {
          const href = anchor.getAttribute('href');

          expect(href).toBeTruthy();
          expect(href).not.toBe('#');
          expect(anchor.textContent?.trim().length ?? 0).toBeGreaterThan(0);
        }
      });
    });
  }
});
