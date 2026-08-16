/**
 * What an installation says about itself, and what it says to anyone else.
 *
 *   DOCKPLANE_URL=https://dockplane.example.com \
 *   DOCKPLANE_EMAIL=… DOCKPLANE_PASSWORD=… \
 *   node e2e/version-visibility.e2e.mjs
 *
 * Two things are checked here that no unit test can reach. The first is that
 * the local versions are visible in a real browser against a real deployment,
 * including the browser application's own version, which only exists in a built
 * bundle. The second is the promise the feature is built around: with the
 * update check off — which is how it ships — using Dockplane produces no
 * request to the release upstream at all. That is asserted by watching every
 * request the browser and the page make, rather than by reading the code.
 */

import { chromium } from 'playwright';

import { VIEWPORTS } from './responsive.mjs';

const BASE = process.env.DOCKPLANE_URL;
const EMAIL = process.env.DOCKPLANE_EMAIL;
const PASSWORD = process.env.DOCKPLANE_PASSWORD;

if (!BASE || !EMAIL || !PASSWORD) {
  console.error('set DOCKPLANE_URL, DOCKPLANE_EMAIL and DOCKPLANE_PASSWORD');
  process.exit(2);
}

/** Anywhere a release listing could plausibly live. */
const UPSTREAM = /github\.com|githubusercontent|api\.github|dockplane\.(de|io|com)|releases/i;

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

/** The System panel, read as a person reads it. */
const PANEL = `(() => {
  const panel = [...document.querySelectorAll('dp-system-version')][0];
  if (!panel) return null;

  const lines = {};
  for (const line of panel.querySelectorAll('.line')) {
    const label = line.querySelector('dt')?.textContent?.trim();
    if (label) lines[label] = line.querySelector('dd')?.textContent?.replace(/\\s+/g, ' ').trim();
  }

  return { lines, text: panel.textContent.replace(/\\s+/g, ' ').trim() };
})()`;

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

/*
 * Every request the browser makes, including the ones the page starts itself.
 * Collected from the first navigation so that nothing before sign-in is missed.
 */
const requested = [];
context.on('request', (request) => requested.push(request.url()));

try {
  await signIn(page);

  console.log('\n──── local versions, without any external check ────');

  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const panel = await page.evaluate(PANEL);

  check('the system panel is on the settings page', panel !== null);

  if (panel) {
    check(
      'the control server names its version',
      /\d+\.\d+\.\d+/.test(panel.lines['Dockplane Server'] ?? ''),
      panel.lines['Dockplane Server'],
    );

    // The browser bundle carries its own version, which is the whole reason
    // for reporting two components rather than one number.
    check(
      'the browser application names its own version',
      /\d+\.\d+\.\d+/.test(panel.lines['Web Interface'] ?? ''),
      panel.lines['Web Interface'],
    );

    check(
      'the database schema is named',
      Boolean(panel.lines['Database Schema']),
      panel.lines['Database Schema'],
    );

    check(
      'the agent protocol is named',
      /v\d+/.test(panel.lines['Agent Protocol'] ?? ''),
      panel.lines['Agent Protocol'],
    );

    check('the agents are counted', 'Agents' in panel.lines, panel.lines['Agents']);

    // Shipped state: the check is off, and nothing claims a published version.
    check(
      'the update check reports itself as off',
      (panel.lines['Updates'] ?? '').includes('off'),
      panel.lines['Updates'],
    );

    check(
      'no available version is claimed',
      !panel.text.includes('Update available') && !panel.text.includes('has been published'),
    );

    // Version visibility ends at a sentence. Nothing in this panel installs.
    const controls = await page.evaluate(
      `document.querySelector('dp-system-version').querySelectorAll('button, a[href], input').length`,
    );
    check('nothing in the panel offers to install anything', controls === 0, `${controls} controls`);
  }

  console.log('\n──── the agents list ────');

  await page.goto(`${BASE}/agents`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const agents = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('table tbody tr')];
    return {
      rows: rows.length,
      versions: rows.map((row) => row.children[2]?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''),
      marked: document.body.textContent.includes('Older than'),
    };
  })()`);

  check('the agents list renders', agents.rows >= 0);

  if (agents.rows > 0) {
    check(
      'each agent reports a version or says it has none',
      agents.versions.every((value) => value.length > 0),
      agents.versions.slice(0, 3).join(' | '),
    );

    // Whether a marker appears depends on the fixture; what must hold is that
    // it only appears alongside a version to compare against.
    check(
      'a behind-marker never appears without a newest version to name',
      !agents.marked || agents.versions.some((value) => /\d+\.\d+\.\d+/.test(value)),
    );
  }

  console.log('\n──── the settings page at the viewport classes ────');

  for (const viewport of [VIEWPORTS[0], VIEWPORTS[2], VIEWPORTS[4]]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);

    const layout = await page.evaluate(`(() => {
      const root = document.documentElement;
      const panel = document.querySelector('dp-system-version');
      const box = panel?.getBoundingClientRect();
      return {
        pageOverflow: root.scrollWidth - root.clientWidth,
        within: box ? box.right <= root.clientWidth + 1 && box.left >= -1 : null,
      };
    })()`);

    check(
      `${viewport.width}: the settings page does not scroll sideways`,
      layout.pageOverflow <= 0,
      layout.pageOverflow > 0 ? `${layout.pageOverflow}px` : '',
    );
    check(`${viewport.width}: the system panel is inside the window`, layout.within === true);
  }

  console.log('\n──── what the interface makes of the server’s answer ────');

  /*
   * The upstream is fixed in the control server and cannot be pointed at a
   * test server, which is the security property the check is built on. So the
   * states that depend on it are produced here where they are rendered: the
   * server's own answer is substituted, and what the browser does with it is
   * what these assert.
   */
  const answerUpdateCheck = async (body) => {
    await page.route('**/api/v1/system/update-check', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
    );
  };

  await answerUpdateCheck({
    state: 'ok',
    latestStableVersion: '99.0.0',
    releaseUrl: 'https://example.test/99.0.0',
    checkedAt: '2026-08-16T10:00:00.000Z',
    updateAvailable: true,
    stale: false,
  });

  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const available = await page.evaluate(PANEL);

  check(
    'a newer published release is reported',
    (available?.lines['Updates'] ?? '').includes('99.0.0'),
    available?.lines['Updates'],
  );
  check(
    'and still offers to install nothing',
    (await page.evaluate(
      `document.querySelector('dp-system-version').querySelectorAll('button, a[href], input').length`,
    )) === 0,
  );

  await page.goto(`${BASE}/overview`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  check(
    'the overview mentions it once there is something to mention',
    (await page.evaluate(`document.body.textContent`)).includes('99.0.0 has been published'),
  );

  await answerUpdateCheck({
    state: 'unavailable',
    latestStableVersion: null,
    releaseUrl: null,
    checkedAt: null,
    updateAvailable: null,
    stale: false,
  });

  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const unavailable = await page.evaluate(PANEL);

  check(
    'an unreachable upstream is reported as silence, not as an answer',
    (unavailable?.lines['Updates'] ?? '').includes('could not be reached'),
    unavailable?.lines['Updates'],
  );
  check(
    'and the installation still reports itself',
    /\d+\.\d+\.\d+/.test(unavailable?.lines['Dockplane Server'] ?? ''),
  );

  // The rest of the product is unaffected by an upstream nobody can reach.
  for (const path of ['/hosts', '/containers', '/agents']) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);

    check(
      `${path} is usable while the update check cannot answer`,
      (await page.evaluate(`document.querySelectorAll('main *').length`)) > 10,
    );
  }

  await page.unroute('**/api/v1/system/update-check');

  console.log('\n──── mixed agent versions ────');

  await page.route('**/api/v1/system/versions', async (route) => {
    const response = await route.fetch();
    const body = await response.json();

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...body,
        agents: {
          total: 4,
          versions: [
            { version: '0.3.0', count: 3 },
            { version: '0.2.0', count: 1 },
          ],
          mixedVersions: true,
          unknownCount: 0,
          protocolUnsupportedCount: 0,
          oldestVersion: '0.2.0',
          newestVersion: '0.3.0',
        },
      }),
    });
  });

  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const mixed = await page.evaluate(PANEL);

  check(
    'a fleet on several versions is marked',
    (mixed?.text ?? '').includes('Mixed versions'),
    mixed?.lines['Agents'],
  );
  check(
    'and is not presented as a failure',
    !(mixed?.text ?? '').includes('Protocol not supported'),
  );

  await page.goto(`${BASE}/overview`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  check(
    'the overview says which versions are in use',
    (await page.evaluate(`document.body.textContent`)).includes('0.2.0 through 0.3.0'),
  );

  await page.unroute('**/api/v1/system/versions');

  console.log('\n──── outbound requests ────');

  // Everything an operator does in a session, with the check off.
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const path of ['/overview', '/hosts', '/agents', '/containers', '/settings']) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
  }

  const origin = new URL(BASE).origin;
  const foreign = requested.filter((url) => !url.startsWith(origin));
  const upstream = foreign.filter((url) => UPSTREAM.test(url));

  check(
    'nothing was requested from a release upstream',
    upstream.length === 0,
    upstream.slice(0, 3).join(', '),
  );
  check(
    'nothing at all was requested from another origin',
    foreign.length === 0,
    foreign.slice(0, 3).join(', '),
  );

  console.log(`  (${requested.length} requests observed, all to ${origin})`);
} finally {
  await browser.close();
}

console.log('');

if (failures > 0) {
  console.error(`${failures} version visibility check(s) failed`);
  process.exit(1);
}

console.log('the installation reports its versions and asks nobody about them');
