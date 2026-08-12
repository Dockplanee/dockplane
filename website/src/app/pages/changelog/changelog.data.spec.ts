import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANGELOG } from './changelog.data';

/**
 * The page data is generated from CHANGELOG.md. These checks fail if the
 * generated module was not refreshed after the changelog changed.
 */
const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const MARKDOWN = readFileSync(join(REPOSITORY_ROOT, 'CHANGELOG.md'), 'utf8');

describe('changelog data', () => {
  it('contains at least one release', () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
  });

  it('covers every release heading in CHANGELOG.md', () => {
    const headings = [...MARKDOWN.matchAll(/^##\s+(?!#)(.*)$/gm)].map((match) =>
      match[1]
        .replace(/(\d{4}-\d{2}-\d{2})/, '')
        .replace(/[[\]]/g, '')
        .replace(/[—–-]\s*$/, '')
        .trim(),
    );

    expect(CHANGELOG.map((release) => release.version)).toEqual(headings);
  });

  it('reproduces every entry from CHANGELOG.md', () => {
    const items = [...MARKDOWN.matchAll(/^[-*]\s+(.*)$/gm)].map((match) => match[1].trim());
    const generated = CHANGELOG.flatMap((release) =>
      release.changes.flatMap((group) => group.items),
    );

    expect(generated).toEqual(items);
  });

  it('groups entries under a known change type', () => {
    const known = [
      'Added',
      'Changed',
      'Deprecated',
      'Fixed',
      'Removed',
      'Security',
      'Known limitations',
    ];

    for (const release of CHANGELOG) {
      for (const group of release.changes) {
        expect(known).toContain(group.type);
        expect(group.items.length).toBeGreaterThan(0);
      }
    }
  });

  it('leaves the date unset while a release is unpublished', () => {
    const unreleased = CHANGELOG.find((release) => release.version === 'Unreleased');

    expect(unreleased?.date).toBeUndefined();
  });
});
