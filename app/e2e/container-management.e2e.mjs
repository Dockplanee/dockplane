/**
 * Managing containers, in a browser, against a host.
 *
 * The instance is the real one built for this run and the host behind it is the
 * test agent: a real enrolment, real mTLS, the real gateway, and an in-memory
 * Docker model at the far end. So what these check is the whole path — what the
 * interface sends, what the server does with it, and what comes back — rather
 * than a component with a stubbed service.
 *
 * The rule under the most scrutiny is the one about secrets. A browser is never
 * shown a stored secret, so it must not send one back: the request a form
 * produces is captured here and read, because the assertion is the request body
 * rather than anything visible on screen.
 */
import { chromium } from 'playwright';

import { startAgent } from './agent.mjs';
import { signIn as apiSignIn } from './stack.mjs';

const BASE = process.env.DOCKPLANE_URL;
const EMAIL = process.env.DOCKPLANE_EMAIL;
const PASSWORD = process.env.DOCKPLANE_PASSWORD;

if (!BASE || !EMAIL || !PASSWORD) {
  console.error('set DOCKPLANE_URL, DOCKPLANE_EMAIL and DOCKPLANE_PASSWORD');
  process.exit(2);
}

const stack = {
  url: BASE,
  email: EMAIL,
  password: PASSWORD,
  gatewayPort: Number(process.env.DOCKPLANE_GATEWAY_PORT),
  caCertPath: process.env.DOCKPLANE_AGENT_CA_PEM_PATH,
};

/** Unmistakable if it ever escaped into a page, a store or a URL. */
const CANARY = 'canary-secret-e2e-1c0ffee';
const SECOND_CANARY = 'canary-secret-e2e-2deadbeef';

/** The viewports the browser suites already use. */
const SIZES = [
  { w: 1440, h: 1000 },
  { w: 1024, h: 768 },
  { w: 390, h: 844 },
];

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, condition, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await condition();

    if (value) {
      return value;
    }

    await sleep(500);
  }

  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Signs the browser in with the session this suite already has.
 *
 * Signing in again through the form would be a second attempt against the
 * credentials rate limit the control server applies to everybody — and with
 * several suites in a run, that budget is what fails somebody else's test.
 */
async function useSession(context, session) {
  const url = new URL(BASE);

  await context.addCookies(
    session.cookie.split('; ').map((entry) => {
      const [name, ...rest] = entry.split('=');

      return {
        name,
        value: rest.join('='),
        domain: url.hostname,
        path: '/',
        httpOnly: false,
        secure: false,
      };
    }),
  );
}

/**
 * The bodies the browser sent.
 *
 * Test instrumentation, not product state: an assertion about what a form
 * produced can only be made where the request is.
 */
function captureRequests(page) {
  const sent = [];

  page.on('request', (request) => {
    if (!request.url().includes('/api/v1/containers')) {
      return;
    }

    const method = request.method();

    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      let body;

      try {
        body = JSON.parse(request.postData() ?? '{}');
      } catch {
        body = {};
      }

      sent.push({ method, url: request.url(), body });
    }
  });

  return sent;
}

/** Console noise that would otherwise pass unnoticed. */
function watchConsole(page) {
  const problems = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      problems.push(message.text());
    }
  });

  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  return problems;
}

async function fillCreateForm(page, { name, image, secret = CANARY }) {
  /*
   * By value, not by label. A host reports its own name once discovery has
   * read it, so what the option says changes under the test.
   */
  /*
   * The first host an operator could actually choose.
   *
   * A run can leave more than one host in the instance — an earlier suite's
   * agent has disconnected by now — and the form offers those but does not let
   * them be picked. Taking the first option with a value would take one of
   * those.
   */
  const hostValue = await page.evaluate(
    () =>
      [...document.querySelectorAll('select[name="hostId"] option')].find(
        (entry) => entry.value && !entry.disabled,
      )?.value ?? '',
  );

  await page.selectOption('select[name="hostId"]', hostValue);
  await page.fill('input[name="name"]', name);
  await page.fill('input[name="image"]', image);

  await page.click('button:has-text("Add port mapping")');
  const ports = page.locator('fieldset:has(legend:text("Port mapping 1")) input');
  await ports.nth(1).fill('8080');
  await ports.nth(2).fill('80');

  await page.click('button:has-text("Add mount")');
  const mount = page.locator('fieldset:has(legend:text("Mount 1"))');
  await mount.locator('input').nth(0).fill('app-data');
  await mount.locator('input').nth(1).fill('/data');

  await page.click('button:has-text("Add variable")');
  const plain = page.locator('fieldset:has(legend:text("Variable 1"))');
  await plain.locator('input[type="text"]').nth(0).fill('LOG_LEVEL');
  await plain.locator('input[type="text"]').nth(1).fill('debug');

  await page.click('button:has-text("Add variable")');
  const secretRow = page.locator('fieldset:has(legend:text("Variable 2"))');
  await secretRow.locator('input[type="text"]').nth(0).fill('DB_PASSWORD');
  await secretRow.locator('input[type="checkbox"]').check();
  await secretRow.locator('input[type="password"]').fill(secret);

  await page.selectOption('select[name="restartPolicy"]', 'always');
}

/** Everywhere a secret could linger once the operator has moved on. */
async function canaryTraces(page, canary) {
  return page.evaluate((value) => {
    const inputs = [...document.querySelectorAll('input')].map((input) => input.value);

    return {
      body: document.body.innerText.includes(value),
      inputs: inputs.some((entry) => entry.includes(value)),
      url: location.href.includes(value),
      local: JSON.stringify(Object.entries(localStorage)).includes(value),
      session: JSON.stringify(Object.entries(sessionStorage)).includes(value),
    };
  }, canary);
}

console.log('container management');

const session = await apiSignIn({ url: BASE, email: EMAIL, password: PASSWORD });
const agent = await startAgent(stack, { session });
const browser = await chromium.launch();

try {
  const context = await browser.newContext({ viewport: { width: SIZES[0].w, height: SIZES[0].h } });
  const page = await context.newPage();
  const sent = captureRequests(page);
  const noise = watchConsole(page);

  await useSession(context, session);

  // The cookie is set on the context; the page has to be at the origin before
  // anything it evaluates can reach a relative path.
  await page.goto(`${BASE}/containers`, { waitUntil: 'networkidle' });

  /*
   * Connected, not merely present.
   *
   * A host exists from the moment it enrols, and the option for it appears
   * then too — but a create against a host whose agent has not finished
   * connecting is refused, which would fail this suite for a reason that has
   * nothing to do with the interface.
   */
  await until('the host to be connected', async () =>
    page.evaluate(async () => {
      const answer = await fetch('/api/v1/hosts', { credentials: 'include' });
      const body = await answer.json();

      return body.hosts?.some((entry) => entry.agent?.connected === true);
    }),
  );

  await page.goto(`${BASE}/containers/new`, { waitUntil: 'networkidle' });
  await page.waitForSelector(
    'select[name="hostId"] option[value]:not([value=""]):not([disabled])',
    {
      state: 'attached',
    },
  );

  // --- creating ------------------------------------------------------------
  const name = `web-${Date.now().toString(36)}`;

  await fillCreateForm(page, { name, image: 'nginx:1.27' });
  await page.locator('form button:has-text("Create container")').click();
  await page.waitForURL(/\/containers\/[0-9a-f-]{36}/, { timeout: 60_000 });

  const detailUrl = page.url();
  const containerId = detailUrl.split('/containers/')[1].split('/')[0];

  check(
    'the browser landed on the Dockplane container, not a Docker id',
    /^[0-9a-f-]{36}$/.test(containerId),
  );

  const created = sent.find((request) => request.method === 'POST');

  check('the create carried the whole configuration', created?.body.image === 'nginx:1.27');
  check(
    'the secret went as a secret',
    created?.body.environment?.some(
      (entry) => entry.key === 'DB_PASSWORD' && entry.operation === 'set-secret',
    ),
  );

  await page.reload({ waitUntil: 'networkidle' });

  check('the container shows as managed', await page.locator('text=Managed').first().isVisible());

  let traces = await canaryTraces(page, CANARY);

  check('no secret in the page after creating', !traces.body && !traces.inputs);
  check(
    'no secret in the address, or in browser storage',
    !traces.url && !traces.local && !traces.session,
  );

  // --- validation ----------------------------------------------------------
  await page.goto(`${BASE}/containers/new`, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[name="image"]');
  await page.locator('form button:has-text("Create container")').click();
  await page.waitForSelector('.field-error');

  check(
    'an empty form is refused with reasons on the fields',
    (await page.locator('.field-error').count()) >= 2,
    `${await page.locator('.field-error').count()} errors`,
  );

  await page.selectOption(
    'select[name="hostId"]',
    await page.evaluate(
      () =>
        [...document.querySelectorAll('select[name="hostId"] option')].find(
          (entry) => entry.value && !entry.disabled,
        )?.value ?? '',
    ),
  );
  await page.fill('input[name="name"]', 'validation-check');
  await page.fill('input[name="image"]', 'nginx:1.27');
  await page.click('button:has-text("Add port mapping")');
  await page.click('button:has-text("Add port mapping")');

  for (const index of [0, 1]) {
    const row = page.locator(`fieldset:has(legend:text("Port mapping ${index + 1}")) input`);
    await row.nth(1).fill('8080');
    await row.nth(2).fill(String(80 + index));
  }

  await page.locator('form button:has-text("Create container")').click();

  check(
    'the same host port twice is refused',
    await page.locator('text=already published').first().isVisible(),
  );

  await page.click('button:has-text("Add label")');
  const label = page.locator('fieldset:has(legend:text("Label 1")) input').first();
  await label.fill('io.dockplane.container-id');
  await page.locator('form button:has-text("Create container")').click();

  check(
    'a label in Dockplane’s own namespace is refused',
    await page.locator('text=reserved by Dockplane').first().isVisible(),
  );

  const beforeInvalid = sent.filter((request) => request.method === 'POST').length;

  check('and none of that reached the server', beforeInvalid === 1, `${beforeInvalid} posts`);

  // --- editing, with the secret left alone ---------------------------------
  await page.goto(`${BASE}/containers/${containerId}/edit`, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[name="image"]');

  check(
    'the stored secret is shown as stored, never as a value',
    await page.locator('text=Secret stored').first().isVisible(),
  );

  await page.fill('input[name="image"]', 'nginx:1.28');
  await page.waitForSelector('text=nginx:1.27 → nginx:1.28');

  check('the review names what changed', await page.locator('.change').first().isVisible());
  check(
    'and says the container will be recreated',
    await page.locator('text=recreated').first().isVisible(),
  );

  await page.click('button:has-text("Apply changes")');
  await page.waitForURL(
    (url) =>
      url.pathname.startsWith(`/containers/${containerId}`) && !url.pathname.endsWith('/edit'),
    { timeout: 60_000 },
  );

  const replaced = sent.find((request) => request.method === 'PUT');
  const untouched = replaced?.body.environment?.find((entry) => entry.key === 'DB_PASSWORD');

  check('the untouched secret was sent as unchanged', untouched?.operation === 'unchanged');
  check('and carried no value at all', untouched && !('value' in untouched));
  check(
    'no masking characters were sent as a value',
    !JSON.stringify(replaced?.body ?? {}).includes('•'),
  );

  await until('the replacement to settle', async () => {
    await page.reload({ waitUntil: 'networkidle' });

    return page
      .locator('text=nginx:1.28')
      .first()
      .isVisible()
      .catch(() => false);
  });

  check('the container kept its address', page.url().includes(containerId));

  const listed = await page.evaluate(async (id) => {
    const answer = await fetch('/api/v1/containers', { credentials: 'include' });
    const body = await answer.json();

    return body.containers.filter((entry) => entry.id === id).length;
  }, containerId);

  check('and there is still exactly one of it', listed === 1, `${listed}`);

  // --- changing the secret -------------------------------------------------
  await page.goto(`${BASE}/containers/${containerId}/edit`, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[name="image"]');
  await page.click('button:has-text("Change secret for DB_PASSWORD")');
  await page.locator('input[type="password"]').first().fill(SECOND_CANARY);

  check(
    'the review says the secret changed and nothing more',
    await page.locator('text=secret changed').first().isVisible(),
  );

  await page.click('button:has-text("Apply changes")');
  await page.waitForURL(
    (url) =>
      url.pathname.startsWith(`/containers/${containerId}`) && !url.pathname.endsWith('/edit'),
    { timeout: 60_000 },
  );

  const changed = sent.filter((request) => request.method === 'PUT').at(-1);
  const secretChange = changed?.body.environment?.find((entry) => entry.key === 'DB_PASSWORD');

  check('the new secret was sent as a secret', secretChange?.operation === 'set-secret');

  traces = await canaryTraces(page, SECOND_CANARY);

  check('and is gone from the page afterwards', !traces.body && !traces.inputs && !traces.url);
  check('and from browser storage', !traces.local && !traces.session);

  // --- removing the secret -------------------------------------------------
  await page.goto(`${BASE}/containers/${containerId}/edit`, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[name="image"]');
  await page.click('button:has-text("Remove DB_PASSWORD")');
  await page.waitForSelector('text=secret removed', { timeout: 10_000 }).catch(() => undefined);

  check(
    'the review says the secret is being removed',
    await page.locator('text=secret removed').first().isVisible(),
  );

  await page.click('button:has-text("Apply changes")');
  await page.waitForURL(
    (url) =>
      url.pathname.startsWith(`/containers/${containerId}`) && !url.pathname.endsWith('/edit'),
    { timeout: 60_000 },
  );

  const removedSecret = sent.filter((request) => request.method === 'PUT').at(-1);

  check(
    'and it was sent as a removal',
    removedSecret?.body.environment?.find((entry) => entry.key === 'DB_PASSWORD')?.operation ===
      'remove',
  );

  const afterRemoval = await until('the variable to be gone', async () => {
    const configuration = await page.evaluate(async (id) => {
      const answer = await fetch(`/api/v1/containers/${id}/configuration`, {
        credentials: 'include',
      });

      return answer.ok ? answer.json() : undefined;
    }, containerId);

    return configuration &&
      !configuration.configuration.environment.some((entry) => entry.key === 'DB_PASSWORD')
      ? configuration
      : undefined;
  });

  check('the configuration no longer has it', Boolean(afterRemoval));

  // --- an outcome nobody can confirm ---------------------------------------
  const unknownName = `unknown-${Date.now().toString(36)}`;

  await agent.dropNext('container.create', { apply: true });
  await page.goto(`${BASE}/containers/new`, { waitUntil: 'networkidle' });
  await fillCreateForm(page, { name: unknownName, image: 'nginx:1.27' });
  await page.locator('form button:has-text("Create container")').click();

  await page.waitForSelector('text=could not confirm', { timeout: 90_000 }).catch(async () => {
    console.log('    page said:', (await page.locator('body').innerText()).slice(0, 400));
    console.log(
      '    posts:',
      JSON.stringify(sent.filter((r) => r.method === 'POST').map((r) => r.body.name)),
    );
  });

  const notice = await page.locator('text=could not confirm').first().innerText();

  check(
    'the interface does not call an unknown outcome a failure',
    !/failed/i.test(notice),
    notice,
  );
  check(
    'and offers nothing that would send it again',
    (await page.locator('button:has-text("Try again")').count()) === 0,
  );

  await agent.reconnect();

  const dispatches = await until('the create to be settled', async () => {
    const state = await agent.state();
    const found = state.containers.find((entry) => entry.name === unknownName);

    return found
      ? state.received.filter((entry) => entry === 'container.create').length
      : undefined;
  });

  // Two creates have been asked for in this run: the first container and this
  // one. An interrupted operation that had been repeated would make it three.
  check('the operation reached the host exactly once', dispatches === 2, `${dispatches}`);

  // --- what may not be changed ---------------------------------------------
  await agent.seed('somebody-elses', {});
  await agent.seed('conflicted-a', { 'io.dockplane.managed': 'true' });

  const external = await until('the external container to be discovered', async () => {
    return page.evaluate(async () => {
      const answer = await fetch('/api/v1/containers', { credentials: 'include' });
      const body = await answer.json();

      return body.containers.find((entry) => entry.name === 'somebody-elses');
    });
  });

  await page.goto(`${BASE}/containers/${external.id}`, { waitUntil: 'networkidle' });

  check(
    'an external container says so',
    await page.locator('text=Externally managed').first().isVisible(),
  );
  check(
    'and offers no way to change it',
    (await page.locator('a:has-text("Edit configuration")').count()) === 0,
  );
  check('and no way to remove it', (await page.locator('button:has-text("Delete")').count()) === 0);

  // --- removing -------------------------------------------------------------
  await page.goto(`${BASE}/containers/${containerId}`, { waitUntil: 'networkidle' });
  await page.click('button:has-text("Delete")');

  const dialog = page.locator('dialog[open]');

  check(
    'the removal says the volumes are kept',
    await dialog.locator('text=Volumes will be kept').isVisible(),
  );
  check('and names the volume it keeps', await dialog.locator('text=app-data').first().isVisible());
  check(
    'and offers no way to delete them',
    (await dialog.locator('input[type="checkbox"]').count()) === 0,
  );

  await dialog.locator('button:has-text("Delete container")').click();
  await page.waitForURL(`${BASE}/containers`, { timeout: 60_000 });

  const gone = await until('the container to leave the list', async () => {
    await page.reload({ waitUntil: 'networkidle' });

    return page.evaluate(async (id) => {
      const answer = await fetch('/api/v1/containers', { credentials: 'include' });
      const body = await answer.json();

      return !body.containers.some((entry) => entry.id === id);
    }, containerId);
  });

  check('and it is gone', gone);

  /*
   * The browser reports every non-2xx response as a console error, and this
   * suite asks for one deliberately. What must stay empty is everything else:
   * an exception, a rejected promise, an error the application itself logged.
   */
  const unexpected = noise.filter((entry) => !entry.startsWith('Failed to load resource'));

  check(
    'no unexpected console errors',
    unexpected.length === 0,
    unexpected.slice(0, 2).join(' | '),
  );

  // --- the form on smaller screens -----------------------------------------
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.w, height: size.h });
    await page.goto(`${BASE}/containers/new`, { waitUntil: 'networkidle' });
    await page.click('button:has-text("Add port mapping")');

    const overflow = await page.evaluate(() => {
      const row = document.querySelector('fieldset.row');

      return row ? row.scrollWidth > row.clientWidth + 1 : false;
    });

    check(`the port row fits at ${size.w}×${size.h}`, !overflow);
  }

  await context.close();
} finally {
  await browser.close();
  await agent.stop();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}

console.log('\ncontainer management: all checks passed');
