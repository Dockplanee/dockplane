/**
 * The search palette, measured in a real browser.
 *
 * This exists because the defect it guards against is invisible to a unit test:
 * the palette set `display` unconditionally, which overrode the browser's
 * `dialog:not([open]) { display: none }`, so a closed dialog was laid out on
 * every page — out of the top layer, without a backdrop, in the document flow
 * below the content. A renderer without layout reports none of that.
 *
 * Runs against a deployed instance rather than a dev server, because that is
 * where the real stylesheet, the real cascade and the real user agent are:
 *
 *   DOCKPLANE_URL=https://dockplane.example.com \
 *   DOCKPLANE_EMAIL=… DOCKPLANE_PASSWORD=… [DOCKPLANE_TOTP_SECRET=…] \
 *   node e2e/search-palette.e2e.mjs
 */

import { createHmac } from 'node:crypto';
import { chromium, firefox } from 'playwright';

const BASE = process.env.DOCKPLANE_URL;
const EMAIL = process.env.DOCKPLANE_EMAIL;
const PASSWORD = process.env.DOCKPLANE_PASSWORD;
const TOTP_SECRET = process.env.DOCKPLANE_TOTP_SECRET ?? '';

if (!BASE || !EMAIL || !PASSWORD) {
  console.error('set DOCKPLANE_URL, DOCKPLANE_EMAIL and DOCKPLANE_PASSWORD');
  process.exit(2);
}

const PAGES = ['/overview', '/hosts', '/containers', '/compose'];
const SIZES = [
  { w: 1728, h: 637 },
  { w: 1440, h: 1000 },
  { w: 1024, h: 768 },
  { w: 390, h: 844 },
];

/** What the browser actually did with the dialog. */
const PROBE = `(() => {
  const d = document.querySelector('dp-search-palette dialog');
  if (!d) return { missing: true };
  const r = d.getBoundingClientRect();
  const c = getComputedStyle(d);
  return {
    open: d.open, modal: d.matches(':modal'), display: c.display, position: c.position,
    x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    vw: innerWidth, vh: innerHeight, occupies: r.width > 0 || r.height > 0,
  };
})()`;

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
}

function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(character).toString(2).padStart(5, '0');
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const digest = createHmac('sha1', Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2))))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, '0');
}

async function signIn(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type=email], input[name=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForTimeout(1800);

  const code = page.locator('input[inputmode=numeric], input[name=code], input[autocomplete="one-time-code"]');

  if (await code.count()) {
    if (!TOTP_SECRET) throw new Error('this account has MFA; set DOCKPLANE_TOTP_SECRET');
    await code.first().fill(totp(TOTP_SECRET));
    await page.click('button[type=submit]');
  }

  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 25_000 });
}

async function openPalette(page) {
  const trigger = page.locator('.search-trigger');

  // The trigger is hidden on narrow layouts, where the keyboard shortcut is the
  // way in. The dialog has to behave identically either way.
  if (await trigger.isVisible().catch(() => false)) {
    await trigger.click();
  } else {
    await page.evaluate(`document.querySelector('dp-search-palette dialog').showModal()`);
  }

  await page.waitForTimeout(350);
}

async function run(engineName, engine, size) {
  const browser = await engine.launch();
  const page = await (await browser.newContext({ viewport: { width: size.w, height: size.h } })).newPage();

  try {
    await signIn(page);
    console.log(`\n──── ${engineName} ${size.w}x${size.h} ────`);

    // The defect: a closed dialog that is laid out anyway. Checked before the
    // palette has ever been opened in this session.
    for (const path of PAGES) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      const closed = await page.evaluate(PROBE);
      check(
        `${path.padEnd(12)} never opened: display=${closed.display}`,
        !closed.open && !closed.modal && closed.display === 'none' && !closed.occupies,
      );
    }

    await page.setViewportSize({ width: Math.max(360, size.w - 200), height: size.h });
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: size.w, height: size.h });
    await page.waitForTimeout(300);
    check('still closed after resize and scroll', (await page.evaluate(PROBE)).display === 'none');

    await openPalette(page);
    const opened = await page.evaluate(PROBE);
    const centreDelta = Math.round(opened.x + opened.w / 2 - opened.vw / 2);
    const topVh = Math.round((opened.y / opened.vh) * 100);

    check(
      `opened modal, in the top layer: display=${opened.display} position=${opened.position}`,
      opened.open && opened.modal && opened.display === 'flex' && opened.position === 'fixed',
    );
    check(
      `centred on the viewport (Δ${centreDelta}px) at ${topVh}vh, fully visible`,
      Math.abs(centreDelta) <= 2 &&
        topVh >= 10 &&
        topVh <= 15 &&
        opened.x >= 0 &&
        opened.y >= 0 &&
        opened.x + opened.w <= opened.vw + 1,
    );

    // Focus and results change the contents, never the frame.
    await page.click('dp-search-palette dialog input');
    await page.waitForTimeout(300);
    const focused = await page.evaluate(PROBE);
    await page.fill('dp-search-palette dialog input', 'e');
    await page.waitForTimeout(600);
    const results = await page.evaluate(PROBE);

    check(
      `focus and results do not move it (${focused.x - opened.x}/${focused.y - opened.y}, ${results.x - focused.x}/${results.y - focused.y})`,
      focused.x === opened.x &&
        focused.y === opened.y &&
        results.x === focused.x &&
        results.y === focused.y,
    );
    check(
      `results scroll inside it (bottom ${results.y + results.h} of ${results.vh})`,
      results.y + results.h <= results.vh,
    );

    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    const dismissed = await page.evaluate(PROBE);
    check(
      `escape closes and removes it from the layout: display=${dismissed.display}`,
      !dismissed.open && dismissed.display === 'none' && !dismissed.occupies,
    );

    // Reopening has to be modal again: a dialog left open non-modally cannot be
    // promoted by showModal(), and would stay unusable for the session.
    await openPalette(page);
    const reopened = await page.evaluate(PROBE);
    check('reopens modal', reopened.open && reopened.modal);
  } finally {
    await browser.close();
  }
}

for (const [name, engine] of [
  ['firefox', firefox],
  ['chromium', chromium],
]) {
  for (const size of SIZES) {
    await run(name, engine, size);
  }
}

console.log(`\n${failures === 0 ? 'search palette: all checks passed' : `search palette: ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
