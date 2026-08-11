import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guard against component class names that collide with a Tailwind utility.
 *
 * Utilities are global, so a component class such as `collapse` inherits
 * `visibility: collapse` for any property the component does not set itself.
 * The result renders as an invisible control and cannot be reproduced in the
 * unit-test DOM, where the global stylesheet is absent.
 */

const APP_DIR = dirname(fileURLToPath(import.meta.url));

/** Tailwind utilities whose names read like ordinary component class names. */
const RESERVED = [
  'absolute',
  'block',
  'border',
  'collapse',
  'columns',
  'contents',
  'container',
  'fixed',
  'flex',
  'grid',
  'hidden',
  'inline',
  'isolate',
  'italic',
  'outline',
  'relative',
  'resize',
  'ring',
  'shadow',
  'static',
  'sticky',
  'table',
  'transform',
  'truncate',
  'underline',
  'uppercase',
  'visible',
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(path);
    }

    return /\.(ts|html)$/.test(entry.name) && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('component class names', () => {
  const pattern = new RegExp(`class="(?:[^"]*\\s)?(${RESERVED.join('|')})(?:\\s[^"]*)?"`, 'g');

  it('never reuses a Tailwind utility name', () => {
    const offences: string[] = [];

    for (const file of sourceFiles(APP_DIR)) {
      const source = readFileSync(file, 'utf8');

      for (const match of source.matchAll(pattern)) {
        offences.push(`${file.slice(APP_DIR.length + 1)}: class="${match[1]}"`);
      }
    }

    expect(offences).toEqual([]);
  });
});
