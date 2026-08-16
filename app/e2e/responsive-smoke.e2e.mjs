/**
 * Whether the interface can be operated at the widths people use.
 *
 *   DOCKPLANE_URL=https://dockplane.example.com \
 *   DOCKPLANE_EMAIL=… DOCKPLANE_PASSWORD=… \
 *   node e2e/responsive-smoke.e2e.mjs
 *
 * A thin pass over representative screens at the five viewport classes, rather
 * than the functional suites run five times: what changes with the window is
 * reach, not behaviour, and running six suites at five sizes would spend
 * twenty minutes to re-prove the behaviour four times over.
 *
 * These assertions are deliberately about reach. 0.2.0 renders every list as
 * one desktop table inside a horizontally scrolling box, so the page reports no
 * overflow while a container's state and actions sit outside the window. Each
 * screen therefore names the columns an operator needs before the list is worth
 * opening, and the check is whether those are in the viewport.
 */

import { chromium } from 'playwright';

import { MEASURE, VIEWPORTS, operationalColumnsInView, tableNeedsSidewaysScroll } from './responsive.mjs';

const BASE = process.env.DOCKPLANE_URL;
const EMAIL = process.env.DOCKPLANE_EMAIL;
const PASSWORD = process.env.DOCKPLANE_PASSWORD;

if (!BASE || !EMAIL || !PASSWORD) {
  console.error('set DOCKPLANE_URL, DOCKPLANE_EMAIL and DOCKPLANE_PASSWORD');
  process.exit(2);
}

/*
 * One screen of each shape the application has: two lists whose columns differ,
 * a list that is usually empty, a form, and the page a session starts on.
 * A screen is named with the columns an operator has to see on it.
 */
const SCREENS = [
  { path: '/overview', label: 'overview', operational: [] },
  { path: '/hosts', label: 'hosts', operational: ['host', 'status'] },
  { path: '/containers', label: 'containers', operational: ['name', 'host', 'status'] },
  { path: '/stacks', label: 'stacks', operational: [] },
  { path: '/audit', label: 'audit', operational: [] },
  { path: '/containers/new', label: 'container create', operational: [] },
  { path: '/settings', label: 'settings', operational: [] },
];

/*
 * The findings the responsive audit recorded were printed rather than failed
 * while they were still true, so that adding the suite did not have to wait for
 * the fix. They are assertions now: the lists drop their secondary columns by
 * priority and stack below a tablet's width, and the settings page no longer
 * moves under its own content.
 */

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
}

async function signIn(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type=email], input[name=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 25_000 });
}

async function measure(page, screen, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(`${BASE}${screen.path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);

  return page.evaluate(MEASURE);
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

try {
  await signIn(page);

  for (const viewport of VIEWPORTS) {
    console.log(`\n──── ${viewport.name} ${viewport.width}x${viewport.height} ────`);

    for (const screen of SCREENS) {
      const found = await measure(page, screen, viewport);

      // The window itself must never scroll sideways.
      check(
        `${screen.label}: the page does not scroll sideways`,
        found.pageOverflow <= 0,
        found.pageOverflow > 0 ? `${found.pageOverflow}px` : '',
      );

      // Navigation is how somebody leaves a screen that does not fit. On a
      // narrow window it lives behind a control rather than on the page, and
      // either route counts.
      check(`${screen.label}: navigation is reachable`, found.navigation === true);

      if (found.table) {
        const columns = operationalColumnsInView(found, screen.operational);

        if (screen.operational.length > 0) {
          check(
            `${screen.label}: the operational columns are in the window`,
            columns.satisfied,
            columns.outside.length ? `outside: ${columns.outside.join(', ')}` : '',
          );
        }

        // The point of dropping columns by priority and stacking below a
        // tablet's width: nothing a list shows should need the window moved.
        check(
          `${screen.label}: the list needs no sideways scroll`,
          !tableNeedsSidewaysScroll(found),
          tableNeedsSidewaysScroll(found)
            ? `${found.table.width}px in ${found.table.fits}px`
            : '',
        );
      }

      if (found.primaryAction !== null) {
        check(`${screen.label}: the primary action is not cut off`, found.primaryAction !== false);
      }

      if (found.dialog) {
        check(`${screen.label}: an open dialog fits the window`, found.dialog.withinViewport);
      }

      // Every target a person can hit is at least the size WCAG asks for. The
      // sort control in a table heading was seventeen pixels, which is the
      // label's own height with no room around it.
      if (found.smallestControl !== null) {
        check(
          `${screen.label}: no control is smaller than 24 pixels`,
          found.smallestControl >= 24,
          found.smallestControl < 24 ? `${found.smallestControl}px` : '',
        );
      }
    }
  }
} finally {
  await browser.close();
}

console.log('');

if (failures > 0) {
  console.error(`${failures} responsive check(s) failed`);
  process.exit(1);
}

console.log('the interface is reachable at every viewport class');
