import { ComponentFixture } from '@angular/core/testing';
import axe, { RunOptions } from 'axe-core';

/**
 * Rules that need real layout information and therefore cannot produce a
 * meaningful result in the jsdom test environment. Contrast is verified against
 * the design tokens instead, in tokens.spec.ts.
 */
const UNSUPPORTED_IN_JSDOM = ['color-contrast'];

const OPTIONS: RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: Object.fromEntries(UNSUPPORTED_IN_JSDOM.map((rule) => [rule, { enabled: false }])),
};

export interface AccessibilityResult {
  readonly violations: readonly string[];
}

/** Runs the axe rule set against a rendered fixture and returns readable failures. */
export async function checkAccessibility(
  fixture: ComponentFixture<unknown>,
): Promise<AccessibilityResult> {
  await fixture.whenStable();

  const results = await axe.run(fixture.nativeElement as HTMLElement, OPTIONS);

  return {
    violations: results.violations.map(
      (violation) =>
        `${violation.id}: ${violation.help} (${violation.nodes.length} node(s))\n` +
        violation.nodes.map((node) => `  ${node.html}`).join('\n'),
    ),
  };
}
