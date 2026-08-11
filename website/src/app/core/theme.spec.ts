import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';

import { THEME_STORAGE_KEY, Theme } from './theme';

describe('Theme', () => {
  let theme: Theme;
  let document: Document;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    theme = TestBed.inject(Theme);
    document = TestBed.inject(DOCUMENT);
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    localStorage.clear();
  });

  it('records the chosen theme on the document element', () => {
    theme.set('light');

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(theme.current()).toBe('light');
  });

  it('persists the choice so it survives a reload', () => {
    theme.set('light');

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('switches between the two themes', () => {
    theme.set('dark');
    theme.toggle();

    expect(theme.current()).toBe('light');

    theme.toggle();

    expect(theme.current()).toBe('dark');
  });

  it('leaves no theme attribute in the prerendered markup', () => {
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
