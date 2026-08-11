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
