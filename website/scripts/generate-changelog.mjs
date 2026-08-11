/**
 * Derives the changelog page data from CHANGELOG.md in the repository root, so
 * the release notes are maintained in exactly one place.
 *
 * Recognised structure:
 *
 *   ## 0.1.0 — 2026-01-15      (or "## Unreleased")
 *   ### Added
 *   - A user-facing change.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '..', 'CHANGELOG.md');
const target = join(root, 'src', 'app', 'pages', 'changelog', 'changelog.data.ts');

const CHANGE_TYPES = ['Added', 'Changed', 'Fixed', 'Removed', 'Security'];
const DATE = /(\d{4}-\d{2}-\d{2})/;

function parse(markdown) {
  const releases = [];
  let release = null;
  let group = null;

  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();

    const releaseHeading = /^##\s+(?!#)(.*)$/.exec(line);
    if (releaseHeading) {
      const heading = releaseHeading[1].trim();
      const date = DATE.exec(heading);
      const version = heading
        .replace(DATE, '')
        .replace(/[[\]]/g, '')
        .replace(/[—–-]\s*$/, '')
        .trim();

      release = { version, date: date?.[1], changes: [] };
      group = null;
      releases.push(release);
      continue;
    }

    const groupHeading = /^###\s+(.*)$/.exec(line);
    if (groupHeading) {
      const type = groupHeading[1].trim();

      if (!CHANGE_TYPES.includes(type)) {
        throw new Error(
          `Unknown changelog section "${type}". Expected one of: ${CHANGE_TYPES.join(', ')}`,
        );
      }
      if (!release) {
        throw new Error(`Section "${type}" appears before any release heading`);
      }

      group = { type, items: [] };
      release.changes.push(group);
      continue;
    }

    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item && group) {
      group.items.push(item[1].trim());
      continue;
    }

    // Wrapped list item: append to the entry it belongs to.
    if (line.trim() && group?.items.length && /^\s+\S/.test(raw)) {
      group.items[group.items.length - 1] += ` ${line.trim()}`;
    }
  }

  return releases.filter((entry) => entry.changes.some((change) => change.items.length > 0));
}

function quote(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function render(releases) {
  const body = releases
    .map((release) => {
      const date = release.date ? `\n    date: ${quote(release.date)},` : '';
      const changes = release.changes
        .filter((change) => change.items.length > 0)
        .map((change) => {
          const items = change.items.map((item) => `          ${quote(item)},`).join('\n');
          return `      {\n        type: ${quote(change.type)},\n        items: [\n${items}\n        ],\n      },`;
        })
        .join('\n');

      return `  {\n    version: ${quote(release.version)},${date}\n    changes: [\n${changes}\n    ],\n  },`;
    })
    .join('\n');

  return [
    '// Generated from CHANGELOG.md by scripts/generate-changelog.mjs. Do not edit.',
    "import { ChangelogRelease } from './changelog-entries';",
    '',
    'export const CHANGELOG: readonly ChangelogRelease[] = [',
    body,
    '];',
    '',
  ].join('\n');
}

const releases = parse(await readFile(source, 'utf8'));

if (releases.length === 0) {
  throw new Error(`No release entries found in ${source}`);
}

await writeFile(target, render(releases), 'utf8');

process.stdout.write(`changelog: ${releases.length} release(s)\n`);
