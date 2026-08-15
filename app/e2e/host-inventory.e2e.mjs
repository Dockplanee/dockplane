/**
 * Host identity, and the difference between quiet and gone.
 *
 * Every case here came out of running RC1 against a real deployment. A machine
 * enrolled more than once leaves a host resource behind for every enrolment,
 * and they all report the same system hostname — so a page that names only the
 * hostname cannot say which resource it means, and a suite that looks up "the
 * host called docker-01" finds whichever one it happens to hit first.
 *
 * The other half is freshness. A host that stops answering keeps its inventory
 * on purpose: an operator looking into an incident needs to see what was there.
 * What that costs is that every reading becomes a claim about the past, and the
 * three states have to stay apart — current, last known, and actually gone.
 *
 * Nothing here identifies anything by name or by position. Each host is found
 * through the agent this suite enrolled, each container through the Docker id
 * its own host reported, so the suite is unaffected by whatever other suites
 * have left in the database.
 */
import { chromium } from 'playwright';

import { nameHost, ownHost, settleHost, startAgent } from './agent.mjs';
import { signIn } from './stack.mjs';

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

/** One system hostname for every identity, which is the whole point. */
const SHARED_HOSTNAME = `shared-${Date.now().toString(36)}`;
const RUN = Date.now().toString(36);

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
 * A request as this suite's session, with a CSRF token that is still valid.
 *
 * The token rotates every time the session is read, and the browser reads it on
 * every page load — so a token this process fetched before opening a page is
 * stale by the time it submits anything. Rather than serialise the two, a
 * refused request is retried once against a freshly issued token, which is what
 * the application itself does with the value it holds.
 */
async function api(session, path, options = {}) {
  const send = () =>
    fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        origin: BASE,
        cookie: session.cookie,
        'x-csrf-token': session.csrfToken,
        ...options.headers,
      },
    });

  let answer = await send();

  if (answer.status === 403 && options.method && options.method !== 'GET') {
    const me = await fetch(`${BASE}/api/v1/auth/me`, { headers: { cookie: session.cookie } });

    if (me.ok) {
      session.csrfToken = (await me.json()).csrfToken;
      answer = await send();
    }
  }

  return { status: answer.status, body: await answer.json().catch(() => ({})) };
}

/**
 * Signs the browser in with the session this suite already has.
 *
 * Signing in again through the form would spend another attempt against the
 * credentials rate limit the control server applies to everybody, and with
 * several suites in a run that budget is what fails somebody else's test.
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
        secure: url.protocol === 'https:',
        sameSite: 'Lax',
      };
    }),
  );
}

/** The row of a table whose text contains a value this suite allocated. */
async function rowContaining(page, selector, needle) {
  return page.evaluate(
    ([where, what]) =>
      [...document.querySelectorAll(where)]
        .map((row) => row.innerText)
        .find((text) => text.includes(what)) ?? '',
    [selector, needle],
  );
}

/** What the API says about one container, read by its own resource id. */
async function containerById(session, id) {
  const { status, body } = await api(session, `/api/v1/containers/${id}`);

  return status === 200 ? body.container : undefined;
}

/** This host's containers, from the listing, filtered to the host that owns them. */
async function containersOfHost(session, hostId) {
  const { body } = await api(session, `/api/v1/containers?hostId=${hostId}&limit=200`);

  return body.containers ?? [];
}

/** Waits for discovery to describe a host the way the caller expects. */
async function untilContainer(session, hostId, dockerId, predicate, what) {
  return until(what, async () => {
    const found = (await containersOfHost(session, hostId)).find(
      (entry) => entry.dockerId === dockerId,
    );

    return predicate(found) ? found : undefined;
  });
}

/**
 * Asks for a discovery pass now rather than waiting for the next scheduled one.
 *
 * The control server polls a connected agent about once a minute, and starts a
 * pass a couple of seconds after any handshake completes. Reconnecting is
 * therefore how a test says "look again" without either reaching into the
 * scheduler or sleeping through an interval it does not control.
 */
async function rediscover(identity) {
  await identity.agent.reconnect();
}

const session = await signIn({ url: BASE, email: EMAIL, password: PASSWORD });

/*
 * Three identities, one system hostname.
 *
 * Two are named the way an operator names a host, through a setup; the third is
 * left unnamed so the fallback to the hostname is exercised by a host that
 * really has no name rather than by a fixture that pretends.
 */
console.log('\n==> enrolling three host identities that report one hostname');

const named = [];

for (const displayName of [`stable-${RUN}`, `rc4-${RUN}`]) {
  const { setupId, token } = await nameHost(stack, session, displayName);
  const agent = await startAgent(stack, {
    hostname: SHARED_HOSTNAME,
    session,
    enrollmentToken: token,
  });

  named.push({ displayName, setupId, agent });
}

const unnamed = { agent: await startAgent(stack, { hostname: SHARED_HOSTNAME, session }) };

const identities = [...named, unnamed];

let browser;

try {
  for (const identity of identities) {
    identity.hostId = await ownHost(BASE, session, identity.agent.agentId, { connected: true });
  }

  /*
   * The control server settles a setup onto its host when the setup is read and
   * the host has enrolled, connected and reported an inventory. The last of
   * those takes a discovery pass, so this reads until it has happened rather
   * than once and hopefully.
   */
  for (const identity of named) {
    await until(`the setup for ${identity.displayName} to settle`, async () => {
      await settleHost(stack, session, identity.setupId);

      const { body } = await api(session, `/api/v1/hosts/${identity.hostId}`);

      return body.host?.displayName === identity.displayName ? body.host : undefined;
    });
  }

  const [stable, rc4] = named;

  const { body: unnamedHost } = await api(session, `/api/v1/hosts/${unnamed.hostId}`);

  check('a host nobody named has no display name of its own', unnamedHost.host?.displayName === null);

  check(
    'three separate host resources exist for one system hostname',
    new Set(identities.map((identity) => identity.hostId)).size === 3,
  );

  /*
   * Each host reports two containers of the same name. That is the RC1 case
   * exactly: the names collide, and only the host tells them apart.
   */
  for (const identity of identities) {
    identity.api = await identity.agent.seed(`api-${RUN}`, {});
    identity.caddy = await identity.agent.seed(`caddy-${RUN}`, {});
  }

  // On the identity that stays connected longest, so the Compose scenario can
  // watch it go from current to last known on its own schedule.
  const projectName = `compose-${RUN}`;
  await unnamed.agent.seedProject(projectName);

  for (const identity of identities) {
    await rediscover(identity);
  }

  for (const identity of identities) {
    await untilContainer(
      session,
      identity.hostId,
      identity.api.dockerId,
      (found) => Boolean(found),
      `discovery to report api-${RUN} on ${identity.hostId}`,
    );
  }

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await useSession(context, session);
  const page = await context.newPage();

  /* ---------------------------------------------------------------- A */
  console.log('\n==== A · several identities, one system hostname ====');

  await page.goto(`${BASE}/hosts`, { waitUntil: 'networkidle' });

  const hostRows = await Promise.all(
    identities.map((identity) =>
      page.evaluate(
        (wanted) =>
          [...document.querySelectorAll('tbody tr')]
            .map((row) => row.innerText)
            .find((text) => text.includes(wanted)) ?? '',
        identity.displayName ?? SHARED_HOSTNAME,
      ),
    ),
  );

  check(
    'each named host appears with the name it was given',
    named.every((identity, index) => hostRows[index].includes(identity.displayName)),
  );

  check(
    'and carries its system hostname underneath',
    named.every((identity, index) => hostRows[index].includes(SHARED_HOSTNAME)),
  );

  check(
    'a host nobody named falls back to the hostname, without repeating it',
    hostRows[2].includes(SHARED_HOSTNAME) &&
      (hostRows[2].match(new RegExp(SHARED_HOSTNAME, 'g')) ?? []).length === 1,
  );

  await page.goto(`${BASE}/agents`, { waitUntil: 'networkidle' });

  const agentRows = await Promise.all(
    identities.map((identity) => rowContaining(page, 'tbody tr', identity.agent.agentId.slice(0, 8))),
  );

  check(
    'every agent has a row of its own',
    agentRows.every((row) => row.length > 0) && new Set(agentRows).size === 3,
  );

  check(
    'and each names the host identity it belongs to',
    named.every((identity, index) => agentRows[index].includes(identity.displayName)),
  );

  const apiContainers = await Promise.all(
    identities.map(async (identity) => {
      const found = (await containersOfHost(session, identity.hostId)).find(
        (entry) => entry.dockerId === identity.api.dockerId,
      );

      return found;
    }),
  );

  check(
    'the same container name on three hosts is three resources',
    new Set(apiContainers.map((entry) => entry?.id)).size === 3,
  );

  check(
    'each is attributed to the host that reported it',
    apiContainers.every((entry, index) => entry?.hostId === identities[index].hostId),
  );

  check(
    'and each carries the display name of that host',
    apiContainers[0]?.hostDisplayName === stable.displayName &&
      apiContainers[1]?.hostDisplayName === rc4.displayName &&
      apiContainers[2]?.hostDisplayName === null,
  );

  /* ---------------------------------------------------------------- I */
  console.log('\n==== I · stack host identity ====');

  const stacks = {};

  for (const identity of [stable, rc4]) {
    const created = await api(session, '/api/v1/stacks', {
      method: 'POST',
      body: JSON.stringify({
        name: `stack-${identity.displayName}`,
        hostId: identity.hostId,
        compose: 'services:\n  web:\n    image: nginx:1.29\n',
        environment: [],
      }),
    });

    check(`a stack saves on ${identity.displayName}`, created.status === 201, `HTTP ${created.status}`);
    stacks[identity.displayName] = created.body.stackId;
  }

  await page.goto(`${BASE}/stacks`, { waitUntil: 'networkidle' });

  const stackRows = await Promise.all(
    [stable, rc4].map((identity) => rowContaining(page, 'tbody tr', `stack-${identity.displayName}`)),
  );

  check(
    'the stack list tells the two host identities apart',
    stackRows[0].includes(stable.displayName) && stackRows[1].includes(rc4.displayName),
  );

  check(
    'and shows the system hostname beneath each',
    stackRows.every((row) => row.includes(SHARED_HOSTNAME)),
  );

  await page.goto(`${BASE}/stacks/${stacks[rc4.displayName]}`, { waitUntil: 'networkidle' });
  const stackDetail = await page.locator('main').innerText();

  check('the stack page names its host identity', stackDetail.includes(rc4.displayName));
  check(
    'and says which machine that is',
    stackDetail.includes(`System hostname: ${SHARED_HOSTNAME}`),
  );

  /* ---------------------------------------------------------------- F */
  console.log('\n==== F · choosing a host for a new container ====');

  await page.goto(`${BASE}/containers/new`, { waitUntil: 'networkidle' });

  const options = await page.evaluate(() =>
    [...document.querySelectorAll('select[name="hostId"] option')].map((option) => ({
      value: option.value,
      label: option.textContent?.trim() ?? '',
      disabled: option.disabled,
    })),
  );

  const optionFor = (hostId) => options.find((option) => option.value === hostId);

  check('a connected host can be chosen', optionFor(stable.hostId)?.disabled === false);
  check(
    'and the option carries the name that tells it from its twin',
    optionFor(stable.hostId)?.label.includes(stable.displayName),
  );

  /* ---------------------------------------------------------------- G */
  console.log('\n==== G · saving a stack for a host that is offline ====');

  await rc4.agent.stop();

  await until('the control server to see the agent go', async () => {
    const { body } = await api(session, `/api/v1/hosts/${rc4.hostId}`);

    return body.host?.agent?.connected === false ? body.host : undefined;
  });

  await page.goto(`${BASE}/stacks/new`, { waitUntil: 'networkidle' });

  const offlineOption = await page.evaluate(
    (wanted) =>
      [...document.querySelectorAll('#stack-host option')].find((option) => option.value === wanted)
        ?.disabled,
    rc4.hostId,
  );

  check('an offline host may still be chosen for a new stack', offlineOption === false);

  await page.selectOption('#stack-host', rc4.hostId);
  await page.fill('#stack-name', `offline-${RUN}`);
  await page.fill('#stack-compose', 'services:\n  web:\n    image: nginx:1.29\n');

  const hint = await page.locator('main').innerText();

  check(
    'the page says it can be saved now and deployed later',
    /agent is offline/i.test(hint) && /saved now/i.test(hint),
  );

  await page.click('button:has-text("Create stack")');
  await page.waitForURL(/\/stacks\/[0-9a-f-]+/, { timeout: 30_000 });

  const savedOffline = /\/stacks\/([0-9a-f-]+)/.exec(page.url())?.[1];

  check('and it saves', Boolean(savedOffline));

  const savedDetail = await until('the saved stack to render its host', async () => {
    const text = await page.locator('main').innerText();

    return text.includes(rc4.displayName) ? text : undefined;
  }).catch(() => page.locator('main').innerText());

  check('the saved stack names the offline host identity', savedDetail.includes(rc4.displayName));
  check(
    'and says which machine that is',
    savedDetail.includes(`System hostname: ${SHARED_HOSTNAME}`),
  );

  /* ---------------------------------------------------------------- H */
  console.log('\n==== H · a stack that was already there when the host went quiet ====');

  await page.goto(`${BASE}/stacks/${stacks[rc4.displayName]}`, { waitUntil: 'networkidle' });
  const existing = await page.locator('main').innerText();

  check('the page is reachable', existing.includes(`stack-${rc4.displayName}`));
  check(
    'it explains what an offline host does and does not prevent',
    /Host offline/.test(existing) && /can be saved/.test(existing) && /cannot be deployed/.test(existing),
  );
  check('editing is still offered', existing.includes('Edit configuration'));

  const blocked = await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .filter((button) => !button.disabled)
      .map((button) => button.textContent?.trim() ?? '')
      .join(' | '),
  );

  check(
    'nothing that would reach the host is offered',
    !/Deploy revision|Roll back|Start stack|Stop stack|Restart stack/.test(blocked),
    blocked.slice(0, 120),
  );

  await page.goto(`${BASE}/stacks/${stacks[rc4.displayName]}/edit`, { waitUntil: 'networkidle' });
  await page.fill('#stack-compose', 'services:\n  web:\n    image: nginx:1.29\n  cache:\n    image: redis:7\n');
  await page.click('button:has-text("Save revision")');

  const revision = await until('the saved revision to appear', async () => {
    const { body } = await api(session, `/api/v1/stacks/${stacks[rc4.displayName]}`);

    return body.stack?.latestRevision?.number === 2 ? body.stack : undefined;
  });

  check('a new revision saves while the host is away', revision.latestRevision.number === 2);

  const deploy = await api(session, `/api/v1/stacks/${stacks[rc4.displayName]}/deploy`, {
    method: 'POST',
    body: JSON.stringify({ revisionId: revision.latestRevision.id }),
  });

  check(
    'and the control server refuses to deploy it',
    deploy.status === 409 && deploy.body.code === 'AGENT_OFFLINE',
    `HTTP ${deploy.status} ${deploy.body.code ?? ''}`,
  );

  /* ---------------------------------------------------------------- B */
  console.log('\n==== B · a host that has stopped answering ====');

  const offlineHost = await until('the host to read as offline', async () => {
    const { body } = await api(session, `/api/v1/hosts/${rc4.hostId}`);

    return body.host?.stale === true ? body.host : undefined;
  });

  check('its last reading is kept', Boolean(offlineHost.observedAt));
  check('and it is marked as the last known one', offlineHost.stale === true);
  check('the agent is reported as gone', offlineHost.agent?.connected === false);

  await page.goto(`${BASE}/hosts/${rc4.hostId}`, { waitUntil: 'networkidle' });
  const hostPage = await page.locator('main').innerText();

  check('the page says the host is offline', /Offline/i.test(hostPage));
  check('it still shows what the host last reported', /Last known/i.test(hostPage));
  check('and says when', /reported/i.test(hostPage));

  /* ---------------------------------------------------------------- C */
  console.log('\n==== C · a container whose host has gone quiet ====');

  const staleContainer = await untilContainer(
    session,
    rc4.hostId,
    rc4.api.dockerId,
    (found) => found?.stale === true,
    'the container to be reported as last known',
  );

  check('the container is kept', Boolean(staleContainer));
  check('and marked as a last observation', staleContainer.stale === true);
  check('with the host identity that owns it', staleContainer.hostDisplayName === rc4.displayName);

  await page.goto(`${BASE}/containers/${staleContainer.id}`, { waitUntil: 'networkidle' });
  const detail = await page.locator('main').innerText();

  check('its page opens', detail.includes(staleContainer.name));
  check('it is not reported as missing', !/not found|does not exist/i.test(detail));
  check('the state is shown as the last known one', /Last known/i.test(detail));
  check('the host identity leads', detail.includes(rc4.displayName));
  check('and the machine follows', detail.includes(`System hostname: ${SHARED_HOSTNAME}`));

  const lifecycle = await page.evaluate(() =>
    [...document.querySelectorAll('.actions button')].map((button) => ({
      label: button.textContent?.trim() ?? '',
      disabled: button.disabled,
    })),
  );

  check(
    'nothing can be carried out on it',
    lifecycle.length > 0 && lifecycle.every((action) => action.disabled),
    lifecycle.map((action) => `${action.label}:${action.disabled}`).join(' '),
  );

  /*
   * Two ways this view can find out, and both have to say the same thing. A
   * host already known to be offline is never asked — the view says so without
   * opening a stream — and a host that goes while a stream is being opened is
   * refused by the control server, which is the path that used to report the
   * condition in the wording for an operation that was not carried out.
   */
  await page.goto(`${BASE}/containers/${staleContainer.id}/logs`, { waitUntil: 'networkidle' });

  const logs = await until('the log view to explain itself', async () => {
    const text = await page.locator('main').innerText();

    return /not reporting|unavailable/i.test(text) ? text : undefined;
  });

  check('the log view says there is no live stream to follow', /not reporting|unavailable/i.test(logs));
  check('and does not claim the container is missing', !/not found|does not exist/i.test(logs));

  const refused = await api(session, `/api/v1/containers/${staleContainer.id}/logs`);

  check(
    'and the control server refuses the stream on its own authority',
    refused.status === 409 && refused.body.code === 'AGENT_OFFLINE',
    `HTTP ${refused.status} ${refused.body.code ?? ''}`,
  );

  /* ---------------------------------------------------------------- J */
  console.log('\n==== J · a Compose project on a host that went quiet ====');

  /*
   * A project has to age exactly as the host and the containers beside it do.
   * For a while it did not: a project page said running next to a host page
   * that already said offline, for as long as the staleness window lasted.
   */
  const liveProject = await until('the project to be discovered', async () => {
    const { body } = await api(session, `/api/v1/compose-projects?hostId=${unnamed.hostId}`);

    return (body.projects ?? []).find((entry) => entry.projectName === projectName);
  });

  check('a project on a connected host is current', liveProject.stale === false);

  await unnamed.agent.stop();

  await until('the control server to see that agent go', async () => {
    const { body } = await api(session, `/api/v1/hosts/${unnamed.hostId}`);

    return body.host?.agent?.connected === false ? body.host : undefined;
  });

  const staleProject = await until('the project to be reported as last known', async () => {
    const { body } = await api(session, `/api/v1/compose-projects?hostId=${unnamed.hostId}`);
    const found = (body.projects ?? []).find((entry) => entry.projectName === projectName);

    return found?.stale === true ? found : undefined;
  });

  check('and stops being current the moment its host does', staleProject.stale === true);
  check('while its last reading is kept', Boolean(staleProject.observedAt));

  await page.goto(`${BASE}/compose`, { waitUntil: 'networkidle' });

  const projectRow = await until('the project row to say so', async () => {
    const row = await rowContaining(page, 'tbody tr', projectName);

    return /Last known/.test(row) ? row : undefined;
  });

  check('the Compose list shows it as the last observation', /Last known/.test(projectRow));

  await page.goto(`${BASE}/compose/${staleProject.id}`, { waitUntil: 'networkidle' });
  const projectPage = await page.locator('main').innerText();

  check('the project page says the same', /Last known/.test(projectPage));
  check('and explains why', /last observation/i.test(projectPage));

  /* ---------------------------------------------------------------- E */
  console.log('\n==== E · an observation that did not complete ====');

  const before = await containersOfHost(session, stable.hostId);

  /*
   * A refused capability never reaches the host model, so the host itself
   * cannot say the pass happened. The control server can: it asks for metrics
   * in the same pass and those succeed, so the host's observation moves on
   * while the container listing is the part that failed.
   */
  const { body: beforePass } = await api(session, `/api/v1/hosts/${stable.hostId}`);

  await stable.agent.failNext('container.list');
  await rediscover(stable);

  await until('the pass with the refused listing to have happened', async () => {
    const { body } = await api(session, `/api/v1/hosts/${stable.hostId}`);

    return body.host?.observedAt && body.host.observedAt !== beforePass.host?.observedAt;
  });

  const after = await containersOfHost(session, stable.hostId);

  check(
    'a pass that failed removes nothing',
    after.length === before.length,
    `${before.length} → ${after.length}`,
  );

  await rediscover(stable);

  const survived = await untilContainer(
    session,
    stable.hostId,
    stable.api.dockerId,
    (found) => found?.stale === false,
    'the next complete pass to restore the normal state',
  );

  check('and the next complete pass leaves it current', survived.stale === false);

  /* ---------------------------------------------------------------- D */
  console.log('\n==== D · a container that is actually gone ====');

  const goneDockerId = stable.api.dockerId;
  const keptDockerId = stable.caddy.dockerId;

  const goneBefore = (await containersOfHost(session, stable.hostId)).find(
    (entry) => entry.dockerId === goneDockerId,
  );

  check('the container is there to begin with', Boolean(goneBefore));

  await stable.agent.removeContainer(goneDockerId);
  await rediscover(stable);

  const remaining = await until('the host to stop reporting it', async () => {
    const listed = await containersOfHost(session, stable.hostId);

    return listed.every((entry) => entry.dockerId !== goneDockerId) ? listed : undefined;
  });

  const kept = remaining.find((entry) => entry.dockerId === keptDockerId);

  check(
    'a complete pass that omits it takes the resource with it',
    remaining.every((entry) => entry.dockerId !== goneDockerId),
  );
  check('the other container on the same host is untouched', Boolean(kept));
  check(
    'and it is not kept as a last observation instead',
    !remaining.some((entry) => entry.id === goneBefore.id),
  );

  const goneDetail = await containerById(session, goneBefore.id);

  check('and its page is a genuine not-found rather than a last observation', !goneDetail);

  await page.goto(`${BASE}/containers/${goneBefore.id}`, { waitUntil: 'networkidle' });
  const gonePage = await page.locator('main').innerText();

  check(
    'the interface says so too',
    /not found|no longer|does not exist/i.test(gonePage),
    gonePage.slice(0, 80).replace(/\n/g, ' '),
  );

  /* ---------------------------------------------------------------- F, part two */
  console.log('\n==== F · the host chosen for a container going away mid-form ====');

  await page.goto(`${BASE}/containers/new`, { waitUntil: 'networkidle' });
  await page.selectOption('select[name="hostId"]', stable.hostId);
  await page.fill('input[name="name"]', `race-${RUN}`);
  await page.fill('input[name="image"]', 'nginx:1.29');

  await stable.agent.stop();

  await until('the control server to see that agent go', async () => {
    const { body } = await api(session, `/api/v1/hosts/${stable.hostId}`);

    return body.host?.agent?.connected === false ? body.host : undefined;
  });

  await page.click('button:has-text("Create container")');
  await sleep(2_000);

  const raced = (await containersOfHost(session, stable.hostId)).filter((entry) =>
    entry.name.startsWith(`race-${RUN}`),
  );

  check(
    'a create submitted after the host went away creates nothing',
    raced.length === 0,
    `${raced.length} container(s)`,
  );

  check('and the browser stayed on the form', /containers\/new/.test(page.url()), page.url());

  /*
   * The rest of the host list, now that one identity is offline and another can
   * be revoked. A host that cannot be used is still shown: hiding it would
   * leave somebody hunting for a host they can see everywhere else.
   */
  const revoked = await api(session, `/api/v1/agents/${unnamed.agent.agentId}/revoke`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'e2e host inventory suite' }),
  });

  check('an agent can be revoked', revoked.status < 300, `HTTP ${revoked.status}`);

  await page.goto(`${BASE}/containers/new`, { waitUntil: 'networkidle' });

  const finalOptions = await page.evaluate(() =>
    [...document.querySelectorAll('select[name="hostId"] option')].map((option) => ({
      value: option.value,
      label: option.textContent?.trim() ?? '',
      disabled: option.disabled,
    })),
  );

  const finalFor = (hostId) => finalOptions.find((option) => option.value === hostId);

  check('an offline host is still listed', Boolean(finalFor(rc4.hostId)));
  check('and cannot be chosen', finalFor(rc4.hostId)?.disabled === true);
  check('the host whose agent was revoked cannot be chosen either', finalFor(unnamed.hostId)?.disabled === true);
  check(
    'the host that went away mid-form cannot be chosen now',
    finalFor(stable.hostId)?.disabled === true,
  );

  /*
   * The empty state belongs to the whole instance, not to this suite: another
   * suite's host may still be connected. So it is asserted against what the
   * select actually offers rather than against an assumption about the run.
   */
  const choosable = finalOptions.filter((option) => option.value && !option.disabled);
  const formText = await page.locator('main').innerText();

  check(
    choosable.length === 0
      ? 'and with nothing left to choose, the page says so'
      : 'and with another host still connected, it does not claim otherwise',
    choosable.length === 0
      ? /No connected hosts/i.test(formText)
      : !/No connected hosts/i.test(formText),
    `${choosable.length} host(s) still connected`,
  );
} finally {
  for (const identity of identities) {
    await identity.agent.stop().catch(() => undefined);
  }

  await browser?.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}

console.log('\nhost identity and freshness hold');
