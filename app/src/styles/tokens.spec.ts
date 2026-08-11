import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Contrast coverage for the semantic colour tokens.
 *
 * Layout-dependent contrast cannot be evaluated in the unit-test environment,
 * so every foreground the application places on a surface is checked directly
 * against the WCAG formula. Both themes are treated as first-class.
 */

type Palette = Record<string, string>;

const TOKENS_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'tokens.css'),
  'utf8',
);

/** Text needs 4.5:1 at the sizes used on the site. */
const TEXT_MINIMUM = 4.5;

/** Non-text indicators such as the focus ring need 3:1. */
const NON_TEXT_MINIMUM = 3;

const SURFACES = ['--dp-canvas', '--dp-surface', '--dp-surface-alt', '--dp-surface-inset'];

const FOREGROUNDS = [
  '--dp-fg',
  '--dp-fg-muted',
  '--dp-accent-text',
  '--dp-status-ok',
  '--dp-status-warn',
  '--dp-status-critical',
  '--dp-status-info',
  '--dp-status-neutral',
];

const TEXT_PAIRS: readonly [foreground: string, background: string][] = [
  ...FOREGROUNDS.flatMap((foreground) =>
    SURFACES.map((background) => [foreground, background] as [string, string]),
  ),
  ['--dp-accent-fg', '--dp-accent'],
];

const NON_TEXT_PAIRS: readonly [foreground: string, background: string][] = SURFACES.map(
  (background) => ['--dp-focus', background] as [string, string],
);

function extractBlock(selector: string): string {
  const start = TOKENS_CSS.indexOf(selector);
  if (start === -1) {
    throw new Error(`Selector ${selector} is missing from tokens.css`);
  }

  const open = TOKENS_CSS.indexOf('{', start);
  const close = TOKENS_CSS.indexOf('}', open);
  return TOKENS_CSS.slice(open + 1, close);
}

function parseDeclarations(block: string): Palette {
  const palette: Palette = {};

  for (const match of block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)) {
    palette[match[1]] = match[2];
  }

  return palette;
}

const light = parseDeclarations(extractBlock(':root {'));
const dark = { ...light, ...parseDeclarations(extractBlock(":root[data-theme='dark']")) };

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const r = channel(Number.parseInt(hex.slice(1, 3), 16));
  const g = channel(Number.parseInt(hex.slice(3, 5), 16));
  const b = channel(Number.parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

function resolve(palette: Palette, token: string): string {
  const value = palette[token];
  if (!value) {
    throw new Error(`Token ${token} is not defined`);
  }
  return value;
}

describe('design tokens', () => {
  const themes: [name: string, palette: Palette][] = [
    ['light', light],
    ['dark', dark],
  ];

  it('defines both themes', () => {
    expect(Object.keys(light).length).toBeGreaterThan(0);
    expect(dark['--dp-canvas']).not.toBe(light['--dp-canvas']);
  });

  for (const [name, palette] of themes) {
    describe(`${name} theme`, () => {
      for (const [foreground, background] of TEXT_PAIRS) {
        it(`renders ${foreground} on ${background} at AA contrast`, () => {
          const ratio = contrast(resolve(palette, foreground), resolve(palette, background));
          expect(ratio).toBeGreaterThanOrEqual(TEXT_MINIMUM);
        });
      }

      for (const [foreground, background] of NON_TEXT_PAIRS) {
        it(`keeps ${foreground} distinguishable on ${background}`, () => {
          const ratio = contrast(resolve(palette, foreground), resolve(palette, background));
          expect(ratio).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM);
        });
      }
    });
  }
});
