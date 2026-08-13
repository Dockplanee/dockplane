/**
 * Managing stacks, in a browser, against a host.
 *
 * The instance is the real one built for this run and the host behind it is the
 * test agent: a real enrolment, real mTLS, the real gateway, and an in-memory
 * Docker model at the far end. What these check is the whole path — what the
 * interface sends, what the server does with it, and what comes back.
 *
 * Two rules get the most scrutiny. Saving is not deploying, which is the whole
 * shape of the product and the thing an interface could most easily blur. And a
 * stored secret is never shown, so the request a form produces is read here
 * rather than anything on screen.
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

const instance = {
  url: BASE,
  email: EMAIL,
  password: PASSWORD,
  gatewayPort: Number(process.env.DOCKPLANE_GATEWAY_PORT),
  caCertPath: process.env.DOCKPLANE_AGENT_CA_PEM_PATH,
};

/** Unmistakable if it ever escaped into a page, a store or a URL. */
const CANARY = 'canary-stack-secret-1c0ffee';
const SECOND_CANARY = 'canary-stack-secret-2deadbeef';

/** Named after this run, so nothing here collides with another suite's fixture. */
const RUN = Math.random().toString(36).slice(2, 8);

/** The host this suite brings, and the only one it deploys to. */
const HOSTNAME = `e2e-stacks-${RUN}`;

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
 * Signing in through the form again would spend another attempt against the
 * credentials rate limit every suite in the run shares.
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

/** The bodies the browser sent to the stack endpoints. */
function captureRequests(page) {
  const sent = [];

  page.on('request', (request) => {
    if (!request.url().includes('/api/v1/stacks')) {
      return;
    }

    if (request.method() !== 'POST' && request.method() !== 'DELETE') {
      return;
    }

    let body;

    try {
      body = JSON.parse(request.postData() ?? '{}');
    } catch {
      body = {};
    }

    sent.push({ url: request.url(), method: request.method(), body });
  });

  return sent;
}

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

/**
 * Clicks something once the interface is willing to be clicked.
 *
 * Deploying is offered only when the host's agent is connected, and the
 * interface learns that from the same discovery everything else waits for. A
 * click the moment the button appears races that, and losing the race says
 * nothing about the product.
 */
async function clickWhenEnabled(page, selector) {
  const target = page.locator(selector).first();

  await until(`${selector} to be offered`, async () =>
    (await target.count()) > 0 ? await target.isEnabled() : false,
  );

  await target.click();
}

/** Everywhere a secret could linger once the operator has moved on. */
async function canaryTraces(page, canary) {
  return page.evaluate((value) => {
    const inputs = [...document.querySelectorAll('input, textarea')].map((input) => input.value);

    return {
      body: document.body.innerText.includes(value),
      inputs: inputs.some((entry) => entry.includes(value)),
      url: location.href.includes(value),
      local: JSON.stringify(Object.entries(localStorage)).includes(value),
      session: JSON.stringify(Object.entries(sessionStorage)).includes(value),
    };
  }, canary);
}

const COMPOSE = (image) =>
  [
    'services:',
    '  web:',
    `    image: ${image}`,
    '    environment:',
    '      DB_PASSWORD: ${DB_PASSWORD}',
    '      APP_ENV: ${APP_ENV}',
    'volumes:',
    '  data: {}',
    '',
  ].join('\n');

/**
 * The host this suite's own agent is connected to.
 *
 * The instance is shared with the other suites in the run and their hosts are
 * still records after their agents have gone, so taking whichever host the form
 * offers first would deploy against one nothing is connected to. The name is no
 * good either: a host is called what it reports about itself once its first
 * inventory arrives, and every test host reports the same thing.
 */
async function ownHost(session, agentId) {
  return until('this suite’s host to be registered', async () => {
    const response = await fetch(`${BASE}/api/v1/hosts`, { headers: { cookie: session.cookie } });

    if (!response.ok) {
      return '';
    }

    const { hosts } = await response.json();

    return hosts.find((host) => host.agent?.id === agentId)?.id ?? '';
  });
}

/** Fills the create form. The compose field is set as a whole, as an editor is. */
async function fillCreateForm(page, { hostId, name, compose, secret = CANARY }) {
  /*
   * The hosts arrive from the server, so the form opens with nothing to choose
   * for a moment. Selecting during that moment picks the placeholder and the
   * form is submitted without a host.
   */
  const hostValue = await until('the host to be offered', async () =>
    page.evaluate(
      (wanted) =>
        [...document.querySelectorAll('#stack-host option')].find((entry) => entry.value === wanted)
          ?.value ?? '',
      hostId,
    ),
  );

  await page.selectOption('#stack-host', hostValue);
  await page.fill('#stack-name', name);
  await page.fill('#stack-compose', compose);

  await page.click('button:has-text("Add variable")');
  const plain = page.locator('fieldset:has(legend:text("Variable 1"))');
  await plain.locator('input[type="text"]').nth(0).fill('APP_ENV');
  await plain.locator('input[type="text"]').nth(1).fill('production');

  await page.click('button:has-text("Add secret")');
  const secretRow = page.locator('fieldset:has(legend:text("Variable 2"))');
  await secretRow.locator('input[type="text"]').nth(0).fill('DB_PASSWORD');
  await secretRow.locator('input[type="password"]').fill(secret);
}

async function run() {
  const session = await apiSignIn(instance);
  const agent = await startAgent(instance, { hostname: HOSTNAME, session });

  const hostId = await ownHost(session, agent.agentId);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: SIZES[0].w, height: SIZES[0].h },
  });
  await useSession(context, session);

  const page = await context.newPage();

  /*
   * Leaving a half-written stack asks before discarding it, which is a native
   * dialog. Playwright dismisses those by default, which would block every
   * navigation this suite makes.
   */
  page.on('dialog', (dialog) => dialog.accept());

  page.on('response', async (response) => {
    if (response.status() >= 400 && response.url().includes('/api/')) {
      console.log(
        '  refused:',
        response.status(),
        response.url(),
        (await response.text()).slice(0, 300),
      );
    }
  });
  const sent = captureRequests(page);
  const consoleProblems = watchConsole(page);

  const stackName = `shop${RUN}`;
  let stackUrl = '';

  try {
    console.log('\n== creating a stack ==');

    await page.goto(`${BASE}/stacks`, { waitUntil: 'networkidle' });
    await page.click('a:has-text("Create stack")');
    await page.waitForURL('**/stacks/new');

    await fillCreateForm(page, { hostId, name: stackName, compose: COMPOSE('nginx:1.27') });

    // The real compiler answers this, not the browser.
    await page.click('button:has-text("Validate")');
    await until('the compiler to answer', async () =>
      (await page.locator('dp-compose-validation').innerText()).includes('valid'),
    );

    check(
      'the compiler says the file is valid',
      (await page.locator('dp-compose-validation').innerText()).includes('Configuration is valid'),
    );

    await page.click('button:has-text("Create stack")');

    await page.waitForURL(/\/stacks\/[0-9a-f-]{36}/);

    // Without the section, so the suite can navigate to each of them.
    stackUrl = page.url().replace(/\/overview$/, '');

    const header = await page.locator('dp-stack-detail > .head').innerText();

    check('the stack was created', header.includes(stackName));
    check('and reports that nothing is deployed', header.includes('Not deployed'));

    const meta = await page.locator('dp-stack-detail > .meta').innerText();

    check('the first revision is the saved one', meta.includes('Saved #1'), meta);
    check('and nothing is running', meta.includes('Deployed Not deployed'), meta);

    const created = sent.find((request) => request.url.endsWith('/api/v1/stacks'));

    check(
      'the secret was sent as a secret',
      created?.body.environment?.some(
        (entry) => entry.operation === 'set-secret' && entry.key === 'DB_PASSWORD',
      ),
    );

    const traces = await canaryTraces(page, CANARY);

    check('the secret is not on the page afterwards', !traces.body && !traces.inputs);
    check('nor in the URL', !traces.url);
    check('nor in browser storage', !traces.local && !traces.session);

    console.log('\n== a Compose file Dockplane cannot deploy ==');

    await page.goto(`${BASE}/stacks/new`, { waitUntil: 'networkidle' });
    await fillCreateForm(page, {
      hostId,
      name: `broken${RUN}`,
      compose: 'services:\n  web:\n    build: .\n',
      secret: SECOND_CANARY,
    });

    await page.click('button:has-text("Validate")');
    await until('the refusal', async () =>
      (await page.locator('dp-compose-validation').innerText()).includes('not one Dockplane'),
    );

    const refusal = await page.locator('dp-compose-validation').innerText();

    check('the path of the problem is shown', refusal.includes('services.web.build'), refusal);
    check(
      'and what is wrong with it in words',
      refusal.toLowerCase().includes('build'),
      refusal.slice(0, 120),
    );

    console.log('\n== saving a change ==');

    await page.goto(`${stackUrl}`, { waitUntil: 'networkidle' });
    await page.click('a:has-text("Edit configuration")');
    await page.waitForURL('**/edit');
    await until('the configuration to load', async () =>
      (await page.locator('#stack-compose').inputValue()).includes('nginx'),
    );

    const storedSecret = page.locator('fieldset.row', { hasText: 'DB_PASSWORD' });

    check(
      'a stored secret is shown as stored and not as a value',
      (await storedSecret.innerText()).includes('Secret stored'),
      (await storedSecret.innerText()).slice(0, 80),
    );

    check(
      'and offers no way to reveal it',
      (await storedSecret.locator('button:has-text("Show")').count()) === 0,
    );

    await page.fill('#stack-compose', COMPOSE('nginx:1.28'));
    await page.click('button:has-text("Save revision")');
    // The stack page redirects to its overview section, so the saved revision
    // lands there rather than on the bare identifier.
    await page.waitForURL(/\/stacks\/[0-9a-f-]{36}\/overview$/);

    const saved = sent.filter((request) => request.url.endsWith('/revisions')).pop();

    check(
      'the untouched secret was sent as unchanged',
      saved?.body.environment?.some(
        (entry) => entry.operation === 'unchanged' && entry.key === 'DB_PASSWORD',
      ),
      JSON.stringify(saved?.body.environment ?? []),
    );

    check(
      'and carried no value with it',
      !saved?.body.environment?.some((entry) => entry.key === 'DB_PASSWORD' && 'value' in entry),
    );

    const afterSave = await page.locator('dp-stack-detail > .meta').innerText();

    check('the newest saved revision is the second', afterSave.includes('Saved #2'), afterSave);
    check('and nothing was deployed by saving', afterSave.includes('Deployed Not deployed'));

    console.log('\n== deploying ==');

    await clickWhenEnabled(page, 'button:has-text("Deploy revision #2")');
    await until('the review', async () => await page.locator('dialog[open]').count());

    const review = await page.locator('dialog[open]').innerText();

    check('the review says what it will do', review.includes('recreated'), review.slice(0, 160));
    check('and that volumes are kept', review.includes('Named volumes are kept'));

    await page.locator('dialog[open] button:has-text("Deploy revision #2")').click();

    await until('the stack to report the revision running', async () =>
      (await page.locator('dp-stack-detail > .meta').innerText()).includes('Deployed #2'),
    );

    const deployed = await page.locator('dp-stack-detail > .meta').innerText();

    check('the deployed revision is the one that was applied', deployed.includes('Deployed #2'));
    check('and the newest saved revision did not change', deployed.includes('Saved #2'));

    await page.click('a:has-text("Services")');
    await until('the services', async () => await page.locator('table tbody tr').count());

    check(
      'the services of the stack are listed',
      (await page.locator('table').innerText()).includes('web'),
    );

    console.log('\n== rolling back ==');

    await page.goto(`${stackUrl}/revisions`, { waitUntil: 'networkidle' });

    check(
      'an older revision offers a rollback',
      (await page.locator('button:has-text("Roll back to revision #1")').count()) === 1,
    );

    await clickWhenEnabled(page, 'button:has-text("Roll back to revision #1")');
    await until('the rollback review', async () => await page.locator('dialog[open]').count());

    const rollbackReview = await page.locator('dialog[open]').innerText();

    check(
      'the rollback says data is not rolled back',
      rollbackReview.includes('does not roll back data'),
      rollbackReview.slice(0, 200),
    );

    await page.locator('dialog[open] button:has-text("Roll back")').click();

    await until('the older revision to be running', async () =>
      (await page.locator('dp-stack-detail > .meta').innerText()).includes('Deployed #1'),
    );

    const rolledBack = await page.locator('dp-stack-detail > .meta').innerText();

    check('the running revision went back', rolledBack.includes('Deployed #1'));
    check('and the newest saved revision stayed where it was', rolledBack.includes('Saved #2'));

    console.log('\n== an answer that never came back ==');

    const before = sent.filter((request) => request.url.endsWith('/deploy')).length;

    await agent.dropNext('stack.deploy', { apply: true });
    await page.goto(`${stackUrl}/revisions`, { waitUntil: 'networkidle' });
    await clickWhenEnabled(page, 'button:has-text("Deploy revision #2")');
    await until('the review', async () => await page.locator('dialog[open]').count());
    await page.locator('dialog[open] button:has-text("Deploy revision #2")').click();

    await until('the interface to report an unconfirmed result', async () =>
      (await page.locator('body').innerText()).includes('could not confirm'),
    );

    check(
      'the interface does not call an unknown outcome a failure',
      (await page.locator('body').innerText()).includes('could not confirm'),
    );

    check(
      'and offers nothing that would send it again',
      (await page.locator('button:has-text("Retry")').count()) === 0,
    );

    check(
      'the operation reached the host exactly once',
      sent.filter((request) => request.url.endsWith('/deploy')).length === before + 1,
      String(sent.filter((request) => request.url.endsWith('/deploy')).length - before),
    );

    await agent.reconnect();

    // Settled from the host: it applied the revision before the answer was lost.
    await until('the stack to be settled from the host', async () => {
      await page.goto(stackUrl, { waitUntil: 'networkidle' });

      return (await page.locator('dp-stack-detail > .meta').innerText()).includes('Deployed #2');
    });

    check(
      'the host settles what the reply did not say',
      (await page.locator('dp-stack-detail > .meta').innerText()).includes('Deployed #2'),
    );

    console.log('\n== a stack that needs attention ==');

    await agent.stackBehaviour({ wontStart: ['web'], leaveHalfApplied: true });
    await page.goto(`${stackUrl}/revisions`, { waitUntil: 'networkidle' });
    await clickWhenEnabled(page, 'button:has-text("Roll back to revision #1")');
    await until('the review', async () => await page.locator('dialog[open]').count());
    await page.locator('dialog[open] button:has-text("Roll back")').click();

    await until('the stack to need attention', async () => {
      await page.goto(stackUrl, { waitUntil: 'networkidle' });

      return (await page.locator('body').innerText()).includes('needs attention');
    });

    const attention = await page.locator('body').innerText();

    check('the stack says it needs attention', attention.includes('needs attention'));
    check(
      'and explains that nothing was removed',
      attention.includes('Nothing has been removed'),
      attention.slice(0, 200),
    );

    console.log('\n== repairing it ==');

    await agent.stackBehaviour({});
    await page.goto(`${stackUrl}/revisions`, { waitUntil: 'networkidle' });

    check(
      'every revision offers a repair',
      (await page.locator('button:has-text("Repair using revision")').count()) > 0,
    );

    const repairs = sent.filter((request) => request.url.endsWith('/deploy')).length;

    await clickWhenEnabled(page, 'button:has-text("Repair using revision #1")');
    await until('the repair review', async () => await page.locator('dialog[open]').count());
    await page.locator('dialog[open] button:has-text("Repair")').click();

    /*
     * Waited for the state the repair was aiming at rather than for the warning
     * to go: the two arrive in the same refresh, and reading between them is
     * how a test reports a failure that is really its own impatience.
     */
    await until('the stack to be running the chosen revision', async () => {
      await page.goto(stackUrl, { waitUntil: 'networkidle' });

      return (await page.locator('dp-stack-detail > .meta').innerText()).includes('Deployed #1');
    });

    const repaired = await page.locator('body').innerText();

    check('needing attention is cleared', !repaired.includes('needs attention'));
    check(
      'and the chosen revision is the running one',
      (await page.locator('dp-stack-detail > .meta').innerText()).includes('Deployed #1'),
    );
    check(
      'the repair was one new attempt',
      sent.filter((request) => request.url.endsWith('/deploy')).length === repairs + 1,
    );

    console.log('\n== stopping and starting ==');

    /*
     * A saved revision the stack is not running, kept for the rest of this
     * section: stopping and starting must not deploy it, which is the way a
     * lifecycle button could most easily do something nobody asked for.
     */
    await page.goto(`${stackUrl}/revisions`, { waitUntil: 'networkidle' });

    const savedBeforeStop = await page.locator('dp-stack-detail > .meta').innerText();

    check('a revision is saved that is not deployed', savedBeforeStop.includes('Saved #2'));
    check('and the deployed one is the older', savedBeforeStop.includes('Deployed #1'));

    await page.goto(stackUrl, { waitUntil: 'networkidle' });

    const serviceLinks = async () => {
      await page.goto(`${stackUrl}/services`, { waitUntil: 'networkidle' });

      return page.evaluate(() =>
        [...document.querySelectorAll('a[href*="/containers/"]')].map((link) => link.getAttribute('href')),
      );
    };

    const linksBefore = await serviceLinks();

    await page.goto(stackUrl, { waitUntil: 'networkidle' });
    await clickWhenEnabled(page, 'button:has-text("Stop stack")');
    await until('the stop confirmation', async () => await page.locator('dialog[open]').count());

    const stopDialog = await page.locator('dialog[open]').innerText();

    check('the confirmation says what stopping does', stopDialog.includes('reverse dependency'));
    check('and that nothing is deleted', stopDialog.includes('no data is deleted'));

    await page.locator('dialog[open] button:has-text("Stop stack")').click();

    await until('the stack to report that it is stopped', async () => {
      await page.goto(stackUrl, { waitUntil: 'networkidle' });

      return (await page.locator('body').innerText()).includes('Stopped');
    });

    const stopped = await page.locator('dp-stack-detail > .meta').innerText();

    check('the deployed revision did not change', stopped.includes('Deployed #1'));
    check('and neither did the newest saved one', stopped.includes('Saved #2'));
    check(
      'a stopped stack is still described as deployed',
      (await page.locator('body').innerText()).includes('still deployed with revision #1'),
    );
    check(
      'stopping is no longer offered',
      (await page.locator('button:has-text("Stop stack")').count()) === 0,
    );

    await page.goto(`${stackUrl}/services`, { waitUntil: 'networkidle' });

    const stoppedServices = await page.locator('dp-stack-services-tab').innerText();

    check(
      'the services report that they are stopped',
      stoppedServices.includes('Stopped') && !stoppedServices.includes('Running'),
      stoppedServices.slice(0, 80),
    );

    await page.goto(stackUrl, { waitUntil: 'networkidle' });
    await clickWhenEnabled(page, 'button:has-text("Start stack")');
    await until('the start confirmation', async () => await page.locator('dialog[open]').count());
    await page.locator('dialog[open] button:has-text("Start stack")').click();

    await until('the stack to be running again', async () => {
      await page.goto(stackUrl, { waitUntil: 'networkidle' });

      return !(await page.locator('body').innerText()).includes('Stopped');
    });

    const started = await page.locator('dp-stack-detail > .meta').innerText();

    check('starting deployed nothing new', started.includes('Deployed #1'));
    check('and the saved revision is still only saved', started.includes('Saved #2'));
    // The same containers: starting one is not building one.
    check(
      'the services are the same resources',
      JSON.stringify(await serviceLinks()) === JSON.stringify(linksBefore),
    );

    console.log('\n== restarting ==');

    await page.goto(stackUrl, { waitUntil: 'networkidle' });
    await clickWhenEnabled(page, 'button:has-text("Restart stack")');
    await until('the restart confirmation', async () => await page.locator('dialog[open]').count());

    const restartDialog = await page.locator('dialog[open]').innerText();

    check('the confirmation says the stack is briefly down', restartDialog.includes('briefly down'));
    check('and that nothing is recreated', restartDialog.includes('Nothing is recreated'));

    await page.locator('dialog[open] button:has-text("Restart stack")').click();

    await until('the restart to be over', async () => {
      await page.goto(stackUrl, { waitUntil: 'networkidle' });

      return (await page.locator('button:has-text("Restart stack")').count()) > 0;
    });

    const restarted = await page.locator('dp-stack-detail > .meta').innerText();

    check('a restart deploys nothing', restarted.includes('Deployed #1'));
    check('and leaves the newest saved revision alone', restarted.includes('Saved #2'));
    check(
      'and keeps every container it restarted',
      JSON.stringify(await serviceLinks()) === JSON.stringify(linksBefore),
    );

    console.log('\n== an operation whose answer is lost ==');

    await page.goto(stackUrl, { waitUntil: 'networkidle' });

    const stopsBefore = sent.filter((request) => request.url.endsWith('/stop')).length;

    // The host does the work and the answer goes with the connection.
    await agent.dropNext('stack.stop', { apply: true });

    await clickWhenEnabled(page, 'button:has-text("Stop stack")');
    await until('the confirmation', async () => await page.locator('dialog[open]').count());
    await page.locator('dialog[open] button:has-text("Stop stack")').click();

    await until('the interface to say the result is not known', async () =>
      (await page.locator('body').innerText()).includes('has not been confirmed'),
    );

    const unknown = await page.locator('body').innerText();

    check('an unknown outcome is not called a failure', !unknown.toLowerCase().includes('failed'));
    check(
      'and nothing offers to send it again',
      (await page.locator('button:has-text("Stop stack")').count()) === 0,
    );
    check(
      'the operation reached the host once',
      sent.filter((request) => request.url.endsWith('/stop')).length === stopsBefore + 1,
    );

    await agent.reconnect();

    // Settled from the host itself, which had in fact stopped the stack.
    await until('the host to settle what happened', async () => {
      await page.goto(stackUrl, { waitUntil: 'networkidle' });

      return (await page.locator('body').innerText()).includes('Stopped');
    });

    check(
      'the host settles it without the operation being repeated',
      sent.filter((request) => request.url.endsWith('/stop')).length === stopsBefore + 1,
    );

    console.log('\n== a stop the host refuses ==');

    await page.goto(stackUrl, { waitUntil: 'networkidle' });
    await clickWhenEnabled(page, 'button:has-text("Start stack")');
    await until('the confirmation', async () => await page.locator('dialog[open]').count());
    await page.locator('dialog[open] button:has-text("Start stack")').click();

    await until('the stack to be running again', async () => {
      await page.goto(stackUrl, { waitUntil: 'networkidle' });

      return (await page.locator('button:has-text("Stop stack")').count()) > 0;
    });

    /*
     * This stack has one service, so a refused stop cannot leave it half moved:
     * either everything stopped or nothing did. What is checked here is the
     * other half of that — a stack the host would not change is reported as
     * unchanged, and stays operable.
     *
     * The half-moved case needs two services and one of them refusing, which is
     * covered where a fixture can be built for it.
     */
    await agent.stackBehaviour({ wontStop: ['web'] });

    await clickWhenEnabled(page, 'button:has-text("Stop stack")');
    await until('the confirmation', async () => await page.locator('dialog[open]').count());
    await page.locator('dialog[open] button:has-text("Stop stack")').click();

    await until('the refusal to be shown', async () =>
      (await page.locator('dp-stack-detail .notice--critical').count()) > 0,
    );

    const refused = await page.locator('dp-stack-detail .notice--critical').innerText();

    check('a stop the host refused is reported', refused.length > 0, refused.slice(0, 60));
    check(
      'the stack is still running',
      !(await page.locator('body').innerText()).includes('Stopped'),
    );
    check(
      'and can still be operated',
      (await page.locator('button:has-text("Stop stack")').count()) > 0,
    );

    await agent.stackBehaviour({});

    console.log('\n== Compose projects found on a host ==');

    await page.goto(`${BASE}/compose`, { waitUntil: 'networkidle' });

    check(
      'discovered projects are a separate area',
      !(await page.locator('body').innerText()).includes('Create stack'),
    );

    console.log('\n== the rest ==');

    /*
     * The browser reports every non-2xx response as a console error, and this
     * suite asks for one deliberately. What must stay empty is everything else:
     * an exception, a rejected promise, an error the application itself logged.
     */
    const unexpected = consoleProblems.filter(
      (entry) => !entry.startsWith('Failed to load resource'),
    );

    check('no unexpected console errors', unexpected.length === 0, unexpected.join('; '));

    for (const size of SIZES) {
      await page.setViewportSize({ width: size.w, height: size.h });
      await page.goto(stackUrl, { waitUntil: 'networkidle' });

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );

      check(`the stack page fits at ${size.w}×${size.h}`, !overflow);
    }

    await page.setViewportSize({ width: SIZES[2].w, height: SIZES[2].h });
    await page.goto(`${stackUrl}/revisions`, { waitUntil: 'networkidle' });

    check(
      'the revision history fits on a phone',
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      )),
    );

    console.log('\n== deleting a stack that never ran ==');

    /*
     * A second stack, saved and never deployed, so the first one is still there
     * for the deletion that has to go through a host.
     */
    await page.goto(`${BASE}/stacks/new`, { waitUntil: 'networkidle' });
    await fillCreateForm(page, {
      hostId,
      name: `draft${RUN}`,
      compose: COMPOSE('nginx:1.27'),
      secret: SECOND_CANARY,
    });

    await page.click('button:has-text("Create stack")');
    await page.waitForURL(/\/stacks\/[0-9a-f-]{36}/);

    const draftUrl = page.url().replace(/\/overview$/, '');
    const removesBeforeDraft = (await agent.state()).received.filter(
      (capability) => capability === 'stack.remove',
    ).length;

    await clickWhenEnabled(page, 'button:has-text("Delete stack")');
    await until('the confirmation', async () => await page.locator('dialog[open]').count());

    const draftDialog = await page.locator('dialog[open]').innerText();

    check('the dialog says the configuration is deleted', draftDialog.includes('revision history'));
    check(
      'and asks for no typed confirmation when nothing is deployed',
      !draftDialog.includes('to confirm'),
    );

    await page.locator('dialog[open] button:has-text("Delete stack")').click();
    await page.waitForURL(/\/stacks$/);

    check(
      'a stack that never ran needs no host',
      (await agent.state()).received.filter((capability) => capability === 'stack.remove')
        .length === removesBeforeDraft,
    );

    const draftGone = await fetch(`${draftUrl.replace(`${BASE}/stacks`, `${BASE}/api/v1/stacks`)}`, {
      headers: { cookie: session.cookie },
    });

    check('and it is gone from the API', draftGone.status === 404, String(draftGone.status));
    // The list is fetched when the page opens, so this waits for the fetch
    // rather than for the navigation that triggered it.
    const draftListed = await until(
      'the deleted stack to leave the list',
      async () => !(await page.locator('body').innerText()).includes(`draft${RUN}`),
      15_000,
    ).catch(() => false);

    check(
      'and from the list',
      draftListed === true,
      draftListed === true ? '' : (await page.locator('body').innerText()).slice(0, 300),
    );

    console.log('\n== deleting a deployed stack ==');

    await page.goto(stackUrl, { waitUntil: 'networkidle' });

    const removesBefore = (await agent.state()).received.filter(
      (capability) => capability === 'stack.remove',
    ).length;

    await clickWhenEnabled(page, 'button:has-text("Delete stack")');
    await until('the confirmation', async () => await page.locator('dialog[open]').count());

    const deleteDialog = await page.locator('dialog[open]').innerText();

    check('the dialog names the volumes it keeps', deleteDialog.includes('data'));
    check('and says data in them is not deleted', deleteDialog.includes('no data in them is deleted'));
    check('and asks for the stack name', deleteDialog.includes('to confirm'));

    // The confirming action stays out of reach until the name is typed.
    const confirmButton = page.locator('dialog[open] button:has-text("Delete stack")');

    check('deleting is not offered before the name is typed', !(await confirmButton.isEnabled()));

    await page.locator('dialog[open] input[type="text"]').fill(stackName);

    check('and is offered once it is', await confirmButton.isEnabled());

    await confirmButton.click();
    await page.waitForURL(/\/stacks$/);

    const state = await agent.state();
    const removes = state.received.filter((capability) => capability === 'stack.remove').length;

    check('the removal reached the host exactly once', removes === removesBefore + 1, String(removes));

    const remaining = state.containers.filter(
      (container) => container.labels?.['io.dockplane.stack-id'],
    );

    check('the stack service containers are gone from the host', remaining.length === 0);
    const listed = await until(
      'the deleted stack to leave the list',
      async () => !(await page.locator('body').innerText()).includes(stackName),
      15_000,
    ).catch(() => false);

    check(
      'the stack is gone from the list',
      listed === true,
      listed === true ? '' : (await page.locator('body').innerText()).slice(0, 300),
    );

    const stackGone = await fetch(`${BASE}/api/v1/stacks/${stackUrl.split('/').pop()}`, {
      headers: { cookie: session.cookie },
    });

    check('and from the API', stackGone.status === 404, String(stackGone.status));

  } finally {
    await browser.close();
    await agent.stop();
  }

  console.log(
    failures === 0
      ? '\nstack management: all checks passed'
      : `\nstack management: ${failures} failed`,
  );

  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
