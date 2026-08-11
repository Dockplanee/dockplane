import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';

import { Seo } from './seo';

describe('Seo', () => {
  let seo: Seo;
  let document: Document;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    seo = TestBed.inject(Seo);
    document = TestBed.inject(DOCUMENT);
  });

  function meta(selector: string): string | null {
    return document.head.querySelector(selector)?.getAttribute('content') ?? null;
  }

  it('applies title, description and canonical URL for a page', () => {
    seo.apply({ title: 'Product — Dockplane', description: 'Product summary.' }, '/product');

    expect(document.title).toBe('Product — Dockplane');
    expect(meta('meta[name="description"]')).toBe('Product summary.');
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      'https://dockplane.de/product',
    );
  });

  it('uses a trailing slash for the canonical homepage URL', () => {
    seo.apply({ title: 'Dockplane', description: 'Home.' }, '/');

    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      'https://dockplane.de/',
    );
  });

  it('emits OpenGraph and Twitter metadata pointing at the social card', () => {
    seo.apply({ title: 'Security — Dockplane', description: 'Security summary.' }, '/security');

    expect(meta('meta[property="og:title"]')).toBe('Security — Dockplane');
    expect(meta('meta[property="og:url"]')).toBe('https://dockplane.de/security');
    expect(meta('meta[property="og:image"]')).toBe('https://dockplane.de/social-card.png');
    expect(meta('meta[property="og:site_name"]')).toBe('Dockplane');
    expect(meta('meta[name="twitter:card"]')).toBe('summary_large_image');
    expect(meta('meta[name="twitter:image"]')).toBe('https://dockplane.de/social-card.png');
  });

  it('keeps a single canonical element across navigations', () => {
    seo.apply({ title: 'A', description: 'A' }, '/product');
    seo.apply({ title: 'B', description: 'B' }, '/security');

    expect(document.head.querySelectorAll('link[rel="canonical"]').length).toBe(1);
  });

  it('marks pages that must stay out of search indexes', () => {
    seo.apply({ title: 'Not found', description: 'Missing.', noIndex: true }, '/404');

    expect(meta('meta[name="robots"]')).toBe('noindex, follow');
  });

  it('returns to an indexable state on the next page', () => {
    seo.apply({ title: 'Not found', description: 'Missing.', noIndex: true }, '/404');
    seo.apply({ title: 'Home', description: 'Home.' }, '/');

    expect(meta('meta[name="robots"]')).toBe('index, follow');
  });
});
