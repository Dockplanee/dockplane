import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
const STYLES_DIR = join(APP_DIR, '..', 'styles');

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

function styleFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return styleFiles(path);
    }

    return /\.(css|ts|html)$/.test(entry.name) && !entry.name.endsWith('.spec.ts') ? [path] : [];
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

/**
 * Every theme token a stylesheet asks for is one the theme defines.
 *
 * `var(--dp-border)` was used fifteen times across five stylesheets and defined
 * nowhere. A missing custom property makes the whole declaration invalid, so
 * those rules drew no border at all — and two of them sat on a background the
 * same colour as the panel behind them, which in dark mode left the input
 * invisible until it was focused. Nothing failed; it simply could not be seen.
 */
describe('theme tokens', () => {
  const defined = new Set(
    [
      ...readFileSync(join(STYLES_DIR, 'tokens.css'), 'utf8').matchAll(/(--dp-[a-z0-9-]+)\s*:/g),
    ].map((match) => match[1]),
  );

  it('are all defined by the theme', () => {
    const missing = new Set<string>();

    for (const file of [...styleFiles(APP_DIR), ...styleFiles(STYLES_DIR)]) {
      const source = readFileSync(file, 'utf8');

      // A token given a fallback is an optional override a component may set,
      // not a value the theme is expected to carry.
      for (const match of source.matchAll(/var\((--dp-[a-z0-9-]+)\s*\)/g)) {
        if (!defined.has(match[1])) {
          missing.add(`${match[1]} (${file.slice(APP_DIR.length + 1)})`);
        }
      }
    }

    expect([...missing]).toEqual([]);
  });

  /*
   * And the control an operator types into is styled in one place. Six copies
   * are how two of them drifted onto a token that had stopped existing.
   */
  it('style a form control in one place', () => {
    const declarations: string[] = [];

    for (const file of [...styleFiles(APP_DIR), ...styleFiles(STYLES_DIR)]) {
      if (/^\s*\.field-input\s*[,{]/m.test(readFileSync(file, 'utf8'))) {
        declarations.push(basename(file));
      }
    }

    expect(declarations).toEqual(['components.css']);
  });

  /*
   * And that rule reaches controls only. `dp-field` names two different things:
   * the search and filter controls carry it themselves, while the sign-in form
   * puts it on the label wrapping each field. An unqualified selector styled
   * that label as though it were the input, which drew a field-shaped box
   * around the label and left the input inside it without a boundary.
   */
  it('style only elements that are form controls', () => {
    const source = readFileSync(join(STYLES_DIR, 'components.css'), 'utf8');
    const unqualified = [...source.matchAll(/^\s*(\.dp-field[^,{]*)[,{]/gm)].map((match) =>
      match[1].trim(),
    );

    expect(unqualified).toEqual([]);
  });
});
