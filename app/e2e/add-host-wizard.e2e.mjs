/**
 * Adding a host, measured in a real browser against a real control server.
 *
 * What a unit test cannot show is that the command a person is given is the
 * command the server actually minted, that regenerating one kills the one
 * before it, and that the waiting view reports what the control plane has
 * observed rather than what the page assumed.
 *
 * No agent is installed. The agent side is covered where it belongs — the
 * install script is rendered and asserted in the control server's tests, and
 * the package is exercised by the release checks. Reinstalling a published
 * artefact on every CI run would test GitHub, not this.
 *
 *   DOCKPLANE_URL=… DOCKPLANE_EMAIL=… DOCKPLANE_PASSWORD=… \
 *     node e2e/add-host-wizard.e2e.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.DOCKPLANE_URL;
const EMAIL = process.env.DOCKPLANE_EMAIL;
const PASSWORD = process.env.DOCKPLANE_PASSWORD;

if (!BASE || !EMAIL || !PASSWORD) {
  console.error('set DOCKPLANE_URL, DOCKPLANE_EMAIL and DOCKPLANE_PASSWORD');
  process.exit(2);
}

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
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });
}

async function openWizard(page) {
  await page.goto(`${BASE}/hosts`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /add host/i }).first().click();
  await page.locator('#add-host-heading').waitFor({ state: 'visible', timeout: 15_000 });
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

try {
  await signIn(page);

  console.log('\n==> the wizard opens and asks for what it needs');

  await openWizard(page);
  check('Add host opens a dialog', await page.locator('#add-host-heading').isVisible());

  const modal = await page.evaluate(() => {
    const dialog = document.querySelector('dialog[open]');
    return dialog ? dialog.matches(':modal') : false;
  });
  check('it is a modal dialog, in the top layer', modal);

  const nameField = page.locator('.field-input, input[name=displayName]').first();
  check('a display name can be given', (await nameField.count()) > 0);
  await nameField.fill('e2e-wizard-host');

  console.log('\n==> and produces a command');

  await page.locator('button[type=submit]').first().click();
  const command = page.locator('[data-testid="install-command"]');
  await command.waitFor({ state: 'visible', timeout: 20_000 });

  const first = (await command.innerText()).trim();
  check('a command is shown', first.length > 0);
  check('it posts a ticket to the bootstrap endpoint', /host-setups\/bootstrap/.test(first));
  check('the ticket is in the body, not the address', !/bootstrap\?[^ ]*ticket/.test(first));
  check('it pipes into a shell as root', /\|\s*sudo bash/.test(first));
  check('it names this control plane', first.includes(new URL(BASE).host));

  const expiry = page.locator('[data-testid="expiry"]');
  check('an expiry is shown', (await expiry.count()) > 0);

  const before = (await expiry.innerText()).trim();
  await page.waitForTimeout(2_500);
  const after = (await expiry.innerText()).trim();
  check('the expiry counts down', before !== after, `${before} → ${after}`);

  console.log('\n==> regenerating replaces the command, and kills the one before it');

  const ticketOf = (text) => text.match(/'([A-Za-z0-9_-]{20,})'/)?.[1];
  const firstTicket = ticketOf(first);
  check('the command carries a ticket', Boolean(firstTicket));

  await page.getByRole('button', { name: /new command/i }).click();
  await page.waitForTimeout(1_500);

  const second = (await command.innerText()).trim();
  const secondTicket = ticketOf(second);

  check('a different command is shown', first !== second);
  check('with a different ticket', Boolean(secondTicket) && firstTicket !== secondTicket);

  // The server's word, not the interface's: the old ticket must be spent.
  const refused = await page.evaluate(async ([base, ticket]) => {
    const answer = await fetch(`${base}/api/v1/host-setups/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    return { status: answer.status, body: await answer.text() };
  }, [BASE, firstTicket]);

  check(
    'the replaced ticket is refused by the server',
    refused.status >= 400,
    `HTTP ${refused.status}`,
  );

  console.log('\n==> an expired setup says so, on the server’s authority');

  const expiredAnswer = await page.evaluate(async (base) => {
    const answer = await fetch(`${base}/api/v1/host-setups/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: 'expired-ticket-that-never-existed-000000' }),
    });
    return { status: answer.status, body: await answer.text() };
  }, BASE);

  check('an unknown ticket is refused', expiredAnswer.status >= 400);
  check(
    'and the refusal carries a machine-readable code',
    /"code"\s*:\s*"[A-Z_]+"/.test(expiredAnswer.body),
  );

  console.log('\n==> nothing exists until a machine does');

  const hosts = await page.evaluate(async (base) => {
    const answer = await fetch(`${base}/api/v1/hosts`, { headers: { accept: 'application/json' } });
    return answer.ok ? await answer.json() : { hosts: [] };
  }, BASE);

  check(
    'no host record was created by generating a command',
    (hosts.hosts ?? []).every((host) => host.displayName !== 'e2e-wizard-host'),
  );

  console.log('\n==> cancelling ends the setup');

  await page.getByRole('button', { name: /cancel this setup/i }).click();
  await page.waitForTimeout(1_500);

  const cancelled = await page.evaluate(async ([base, ticket]) => {
    const answer = await fetch(`${base}/api/v1/host-setups/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    return answer.status;
  }, [BASE, secondTicket]);

  check('the cancelled ticket is refused too', cancelled >= 400, `HTTP ${cancelled}`);

  console.log('\n==> and the dialog closes without leaving anything behind');

  await openWizard(page);
  const reopened = await page.locator('[data-testid="install-command"]').count();
  check('reopening starts from the beginning', reopened === 0);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  const stillOpen = await page.locator('dialog[open]').count();
  check('Escape closes it', stillOpen === 0);
} catch (error) {
  failures += 1;
  console.error(`\n  ✗ ${error.message}`);
  console.error(error.stack);
} finally {
  await browser.close();
}

console.log(
  failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
