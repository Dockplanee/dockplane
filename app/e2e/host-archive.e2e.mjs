/**
 * Archiving a host, against a real deployment and real agents.
 *
 *   DOCKPLANE_URL=… DOCKPLANE_EMAIL=… DOCKPLANE_PASSWORD=… \
 *   node e2e/host-archive.e2e.mjs
 *
 * Two things can only be shown here. The first is that archiving one enrolment
 * of a machine leaves the others alone: this suite enrols three agents under
 * one system hostname, which is the shape that makes a hostname-based rule look
 * reasonable and be wrong. The second is that a host in use cannot be archived
 * — the agent is really connected, and the refusal comes from the control
 * server rather than from a disabled button.
 *
 * No database is touched. Every state here is produced the way an operator
 * would produce it: an agent connects, an agent stops, somebody archives.
 */
import { chromium } from 'playwright';

import { ownHost, startAgent } from './agent.mjs';
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
const SHARED = `archive-${Date.now().toString(36)}`;

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

    if (value) return value;
    await sleep(500);
  }

  throw new Error(`timed out waiting for ${what}`);
}

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
        httpOnly: true,
        secure: url.protocol === 'https:',
      };
    }),
  );
}

const session = await signIn(stack);
const browser = await chromium.launch();
const context = await browser.newContext();
await useSession(context, session);
const page = await context.newPage();

const identities = [];

try {
  console.log('\n──── A · several enrolments of one machine ────');

  for (const label of ['first', 'second', 'third']) {
    const agent = await startAgent(stack, { hostname: SHARED, session });
    const hostId = await ownHost(BASE, session, agent.agentId, { connected: true });

    identities.push({ label, agent, hostId });
  }

  const hostIds = new Set(identities.map((identity) => identity.hostId));

  check('three enrolments produced three host identities', hostIds.size === 3, [...hostIds].join(' '));

  const hostnames = await Promise.all(
    identities.map(async (identity) => (await api(session, `/api/v1/hosts/${identity.hostId}`)).body.host.hostname),
  );

  check('and they all report the same system hostname', new Set(hostnames).size === 1, hostnames[0]);

  // Something for each of them to have run, so history has content.
  for (const identity of identities) {
    await identity.agent.seed(`web-${identity.label}`, {});
  }

  await until('the containers to be discovered', async () => {
    const { body } = await api(session, '/api/v1/containers?limit=200');

    return identities.every((identity) =>
      body.containers?.some((container) => container.hostId === identity.hostId),
    );
  });

  check('each identity has a container of its own', true);

  console.log('\n──── K · a connected host cannot be archived ────');

  const connected = identities[0];
  const refused = await api(session, `/api/v1/hosts/${connected.hostId}/archive`, { method: 'POST' });

  check('the control server refuses it', refused.status === 409, `status ${refused.status}`);
  check('and says why', refused.body.code === 'HOST_CONNECTED', refused.body.code);

  const stillActive = await api(session, `/api/v1/hosts/${connected.hostId}`);
  check('the host is untouched', stillActive.body.host.archived === false);

  console.log('\n──── B · archiving a host that has stopped answering ────');

  const retiring = identities[1];
  await retiring.agent.stop();

  await until('the agent to be seen as gone', async () => {
    const { body } = await api(session, `/api/v1/hosts/${retiring.hostId}`);

    return body.host?.agent?.connected === false;
  });

  const archived = await api(session, `/api/v1/hosts/${retiring.hostId}/archive`, { method: 'POST' });

  check('it is archived', archived.status === 200 && archived.body.host.archived === true);
  check('and the moment is recorded', typeof archived.body.host.archivedAt === 'string');

  console.log('\n──── C+D · what the lists show ────');

  const active = await api(session, '/api/v1/hosts?limit=200');
  const onlyArchived = await api(session, '/api/v1/hosts?scope=archived&limit=200');
  const all = await api(session, '/api/v1/hosts?scope=all&limit=200');

  const ids = (response) => new Set(response.body.hosts.map((host) => host.id));

  check('it has left the active list', !ids(active).has(retiring.hostId));
  check('the other identities are still there', ids(active).has(connected.hostId));
  check('it appears under archived', ids(onlyArchived).has(retiring.hostId));
  check('and under all', ids(all).has(retiring.hostId) && ids(all).has(connected.hostId));

  await page.goto(`${BASE}/hosts`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  // The rows, not the page: the scope filter itself carries the word.
  const activeRows = await page.evaluate(
    `[...document.querySelectorAll('table tbody tr')].map((row) => row.textContent).join(' | ')`,
  );

  check('the browser shows the active hosts only', !activeRows.includes('Archived'));

  await page.selectOption('dp-select-filter#host-scope select', 'archived');
  await page.waitForTimeout(1200);

  const shownArchived = await page.evaluate(`document.body.textContent`);
  check('and marks them when the archived ones are asked for', shownArchived.includes('Archived'));

  console.log('\n──── E+F · what history goes on saying ────');

  const containers = await api(session, '/api/v1/containers?limit=200');
  const historical = containers.body.containers.filter((c) => c.hostId === retiring.hostId);

  check('its containers are still listed', historical.length > 0, `${historical.length}`);
  check(
    'and still name the host they were on',
    historical.every((container) => container.hostname === SHARED),
  );

  const detail = await api(session, `/api/v1/hosts/${retiring.hostId}`);
  check('the archived host reads directly', detail.status === 200 && detail.body.host.archived === true);

  await page.goto(`${BASE}/hosts/${retiring.hostId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const detailText = await page.evaluate(`document.body.textContent`);
  check('its page says it is archived rather than missing', detailText.includes('archived'));
  check('and does not claim it is gone', !detailText.toLowerCase().includes('not found'));

  const containerOfArchived = historical[0];

  if (containerOfArchived) {
    await page.goto(`${BASE}/containers/${containerOfArchived.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    const containerText = await page.evaluate(`document.body.textContent`);
    check('a container on it still shows which machine it was on', containerText.includes(SHARED));
  }

  console.log('\n──── G+H · what it is no longer offered for ────');

  const created = await api(session, '/api/v1/containers', {
    method: 'POST',
    body: JSON.stringify({ hostId: retiring.hostId, name: `new-${SHARED}`, image: 'nginx:1.27' }),
  });

  check('a container cannot be created on it', created.status === 409, `status ${created.status}`);
  check('for the stated reason', created.body.code === 'HOST_ARCHIVED', created.body.code);

  const stack1 = await api(session, '/api/v1/stacks', {
    method: 'POST',
    body: JSON.stringify({
      name: `arch-${Date.now().toString(36)}`,
      hostId: retiring.hostId,
      compose: 'services:\n  web:\n    image: nginx:1.27\n',
    }),
  });

  check('a stack cannot be created for it', stack1.status === 409, `status ${stack1.status}`);

  await page.goto(`${BASE}/containers/new`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const offered = await page.evaluate(`(() => {
    const select = document.querySelector('select[id*="host" i], select');
    return select ? [...select.options].map((option) => option.value) : [];
  })()`);

  check(
    'the create form does not offer it as a target',
    !offered.includes(retiring.hostId),
    `${offered.length} offered`,
  );

  console.log('\n──── L · reporting again does not undo the decision ────');

  /*
   * The identities that are still connected go on reporting, and discovery
   * goes on writing what they say. What must not happen is the archive state
   * being written back by any of that.
   *
   * The stronger form of this — an inventory write against the archived host's
   * own record — is asserted at the API level, where the write can be made
   * directly. Enrolling again here would produce a new identity rather than
   * reconnecting this one, which is the limitation archiving exists alongside.
   */
  await identities[2].agent.reconnect();
  await sleep(3000);

  const afterHeartbeat = await api(session, `/api/v1/hosts/${retiring.hostId}`);

  check(
    'the archived host is still archived after other agents report',
    afterHeartbeat.body.host.archived === true,
  );
  check(
    'and its archived moment is unchanged',
    afterHeartbeat.body.host.archivedAt === archived.body.host.archivedAt,
  );

  console.log('\n──── I+J · restoring ────');

  const restored = await api(session, `/api/v1/hosts/${retiring.hostId}/unarchive`, {
    method: 'POST',
  });

  check('it is restored', restored.status === 200 && restored.body.host.archived === false);

  const activeAgain = await api(session, '/api/v1/hosts?limit=200');
  check('and is back in the active list', ids(activeAgain).has(retiring.hostId));

  const createdAfter = await api(session, '/api/v1/containers', {
    method: 'POST',
    body: JSON.stringify({
      hostId: retiring.hostId,
      name: `after-${SHARED}`,
      image: 'nginx:1.27',
    }),
  });

  // Its agent is gone, so this fails for that reason and not for being archived.
  check(
    'and is no longer refused for being archived',
    createdAfter.body.code !== 'HOST_ARCHIVED',
    createdAfter.body.code ?? `status ${createdAfter.status}`,
  );

  console.log('\n──── the identities are still separate ────');

  const finalAll = await api(session, '/api/v1/hosts?scope=all&limit=200');
  const mine = finalAll.body.hosts.filter((host) => host.hostname === SHARED);

  check('every enrolment is still its own host', mine.length >= 3, `${mine.length}`);
  check('nothing was merged by archiving one of them', new Set(mine.map((h) => h.id)).size === mine.length);
} finally {
  await browser.close();

  for (const identity of identities) {
    await identity.agent.stop().catch(() => undefined);
  }
}

console.log('');

if (failures > 0) {
  console.error(`${failures} host archive check(s) failed`);
  process.exit(1);
}

console.log('archiving takes a host out of the working set and nothing else');
