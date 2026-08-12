import { renderPage } from '../../../testing/page-harness';
import { Docs } from './docs';
import { DOC_SECTIONS } from './docs.data';

/**
 * The documentation index is generated from docs/. These check that it arrived
 * and that the page renders it — an empty or half-written generation would
 * otherwise produce a page that looks deliberate and says nothing.
 */
describe('the documentation index', () => {
  it('covers every section the documentation is organised into', () => {
    expect(DOC_SECTIONS.map((section) => section.title)).toEqual([
      'Getting started',
      'Operations',
      'Security',
      'Reference',
    ]);
  });

  it('has pages in every section, each with a title and a summary', () => {
    for (const section of DOC_SECTIONS) {
      expect(section.pages.length).toBeGreaterThan(0);

      for (const page of section.pages) {
        expect(page.title.length).toBeGreaterThan(0);
        expect(page.summary.length).toBeGreaterThan(0);
        expect(page.url).toMatch(
          /^https:\/\/github\.com\/Dockplanee\/dockplane\/blob\/main\/docs\/.+\.md$/,
        );
      }
    }
  });

  it('names the pages an operator needs before anything else', async () => {
    const titles = DOC_SECTIONS.flatMap((section) => section.pages.map((page) => page.title));

    expect(titles).toContain('Overview');
    expect(titles).toContain('Installation');
    expect(titles).toContain('Add a Host');
    expect(titles).toContain('Upgrading');
    expect(titles).toContain('Known Limitations');
  });

  it('renders every page it lists, as a link', async () => {
    const fixture = await renderPage(Docs);
    const rendered = fixture.nativeElement as HTMLElement;

    for (const section of DOC_SECTIONS) {
      for (const page of section.pages) {
        const link = rendered.querySelector<HTMLAnchorElement>(`a[href="${page.url}"]`);

        expect(link, `${page.title} is not linked`).toBeTruthy();
        expect(link?.textContent?.trim()).toBe(page.title);
      }
    }
  });
});
