import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every column says how much it matters, and says it in both places.
 *
 * A list drops its secondary columns by priority rather than by a rule per
 * screen, and a column is two elements: the heading and the cell. Marking one
 * and not the other, or marking them differently, takes a heading away from a
 * column that is still there — or the reverse. Both mistakes were made while
 * the priorities were first written down, and neither shows up in a rendered
 * page narrow enough to hide the column anyway.
 */

const app = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every list that drops columns by priority. */
const TABLES = [
  'app/features/overview/overview.html',
  'app/features/hosts/host-list.html',
  'app/features/agents/agent-list.html',
  'app/features/shared/container-table.html',
  'app/features/shared/compose-table.ts',
  'app/features/operations/action-history.ts',
  'app/features/administration/audit-log.ts',
  'app/features/administration/user-list.ts',
  'app/features/settings/security.html',
];

const PRIORITIES = ['p0', 'p1', 'p2', 'p3'];

function priorityOf(tag: string): string {
  return /data-priority="(\w+)"/.exec(tag)?.[1] ?? 'p0';
}

function columns(markup: string): { headings: string[]; cells: string[] } {
  const body = markup.slice(markup.indexOf('<tbody'));

  return {
    headings: (markup.match(/<th scope="col"[^>]*>/g) ?? []).map(priorityOf),
    cells: (body.match(/<(?:td|th scope="row")[^>]*>/g) ?? []).map(priorityOf),
  };
}

describe('column priorities', () => {
  for (const table of TABLES) {
    const markup = readFileSync(join(app, table), 'utf8');
    const { headings, cells } = columns(markup);
    const name = table.split('/').pop();

    it(`${name} declares one priority per column`, () => {
      expect(headings.length).toBeGreaterThan(0);
      expect(cells.length).toBe(headings.length);
    });

    it(`${name} gives a heading and its cell the same priority`, () => {
      expect(cells).toEqual(headings);
    });

    it(`${name} uses only the defined priorities`, () => {
      for (const priority of [...headings, ...cells]) {
        expect(PRIORITIES).toContain(priority);
      }
    });

    // A list whose every column is secondary would empty itself on a narrow
    // window. Something has to survive.
    it(`${name} keeps at least one column at every width`, () => {
      expect(headings.filter((priority) => priority === 'p0').length).toBeGreaterThan(0);
    });
  }
});
