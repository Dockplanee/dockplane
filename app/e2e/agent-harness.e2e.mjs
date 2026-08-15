/**
 * The test agent, before any browser depends on it.
 *
 * Everything the browser suites do to a container goes through this: the real
 * API, real authorization, the real gateway, and a simulated host behind it. If
 * that path is wrong, the browser tests fail for reasons that have nothing to
 * do with the interface — so it is proven here first, with no browser involved.
 *
 * What is being checked is the server's own wiring. A create that the host
 * performed has to become a managed container with the configuration it was
 * given; a replacement has to keep the Dockplane container and change only the
 * Docker one; a removal has to leave nothing behind. None of that is asserted
 * from what the agent replied — it is read back out of the API afterwards.
 */
import { startAgent } from './agent.mjs';
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

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(session, path, options = {}) {
  const answer = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      origin: BASE,
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken,
      ...options.headers,
    },
  });

  return { status: answer.status, body: await answer.json().catch(() => ({})) };
}

/**
 * Waits for the state the server reaches on its own.
 *
 * Discovery runs on a timer, so a container that was just created appears when
 * the next pass reads the host. Polling the read model is what a browser does
 * too; nothing here reaches past the API to hurry it along.
 */
async function until(what, condition, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;

  while (Date.now() < deadline) {
    last = await condition();

    if (last) {
      return last;
    }

    await sleep(1_000);
  }

  throw new Error(`timed out waiting for ${what}`);
}

console.log('the test agent and the server behind it');

const session = await signIn({ url: BASE, email: EMAIL, password: PASSWORD });
const agent = await startAgent(stack, { session });

try {
  // --- the host arrives, because the gateway said so ----------------------
  const host = await until('the host to be connected', async () => {
    const { body } = await api(session, '/api/v1/hosts');

    return body.hosts?.find((entry) => entry.agent?.connected === true);
  });

  check('a host connected over mTLS', Boolean(host), host?.hostname);

  // --- create --------------------------------------------------------------
  const name = `harness-${Date.now().toString(36)}`;

  const created = await api(session, '/api/v1/containers', {
    method: 'POST',
    body: JSON.stringify({
      hostId: host.id,
      name,
      image: 'nginx:1.27',
      ports: [{ containerPort: 80, hostPort: 8080, protocol: 'tcp' }],
      environment: [
        { operation: 'set', key: 'LOG_LEVEL', value: 'debug' },
        { operation: 'set-secret', key: 'DB_PASSWORD', value: 'harness-canary-value' },
      ],
    }),
  });

  check('create was accepted', created.status === 201, `status ${created.status}`);

  const containerId = created.body.containerId;
  const onHost = await agent.state();
  const built = onHost.containers.find((entry) => entry.name === name);

  check('the host built the container', Boolean(built));
  check(
    'it carries the identity the server allocated',
    Boolean(containerId) && built?.labels['io.dockplane.container-id'] === containerId,
  );

  const afterCreate = await api(session, `/api/v1/containers/${containerId}`);

  check(
    'the server reconciled it to managed',
    afterCreate.body.container?.management?.kind === 'managed',
    afterCreate.body.container?.management?.kind,
  );

  const configuration = await api(session, `/api/v1/containers/${containerId}/configuration`);

  check('its configuration is readable', configuration.status === 200);
  check(
    'the secret comes back as a secret and nothing else',
    configuration.body.configuration?.environment?.some(
      (variable) =>
        variable.key === 'DB_PASSWORD' && variable.secret && variable.value === undefined,
    ),
  );
  check(
    'no secret value anywhere in the answer',
    !JSON.stringify(configuration.body).includes('harness-canary-value'),
  );

  // --- replace -------------------------------------------------------------
  const replaced = await api(session, `/api/v1/containers/${containerId}`, {
    method: 'PUT',
    body: JSON.stringify({
      name,
      image: 'nginx:1.28',
      environment: [{ operation: 'unchanged', key: 'DB_PASSWORD' }],
    }),
  });

  check('replace was accepted', replaced.status === 200, `status ${replaced.status}`);

  const afterReplace = await api(session, `/api/v1/containers/${containerId}`);

  check(
    'the Dockplane container is the same one',
    Boolean(containerId) && afterReplace.body.container?.id === containerId,
  );
  check(
    'Docker gave it a different container',
    Boolean(afterReplace.body.container?.dockerId) &&
      afterReplace.body.container?.dockerId !== afterCreate.body.container?.dockerId,
  );

  const changed = await api(session, `/api/v1/containers/${containerId}/configuration`);

  check('the new configuration is current', changed.body.configuration?.image === 'nginx:1.28');
  check(
    'the untouched secret is still there',
    changed.body.configuration?.environment?.some((variable) => variable.key === 'DB_PASSWORD'),
  );

  // --- remove --------------------------------------------------------------
  const removed = await api(session, `/api/v1/containers/${containerId}`, {
    method: 'DELETE',
    body: JSON.stringify({ stopFirst: true }),
  });

  check('remove was accepted', removed.status === 200, `status ${removed.status}`);

  const gone = await api(session, `/api/v1/containers/${containerId}`);

  check('the container is no longer a resource', gone.status === 404, `status ${gone.status}`);

  const hostAfter = await agent.state();

  check(
    'and it is no longer on the host',
    hostAfter.containers.length >= 0 && !hostAfter.containers.some((entry) => entry.name === name),
  );

  // --- an outcome the server cannot learn -----------------------------------
  const unknownName = `harness-unknown-${Date.now().toString(36)}`;

  await agent.dropNext('container.create', { apply: true });

  const unknown = await api(session, '/api/v1/containers', {
    method: 'POST',
    body: JSON.stringify({ hostId: host.id, name: unknownName, image: 'nginx:1.27' }),
  });

  check(
    'an interrupted create is not reported as a failure',
    unknown.status === 503 && unknown.body.code === 'OPERATION_OUTCOME_UNKNOWN',
    `${unknown.status} ${unknown.body.code ?? ''}`,
  );

  const blocked = await api(session, '/api/v1/containers', {
    method: 'POST',
    body: JSON.stringify({ hostId: host.id, name: unknownName, image: 'nginx:1.27' }),
  });

  check(
    'and a retry of it is refused rather than repeated',
    blocked.status === 409,
    `${blocked.status} ${blocked.body.code ?? ''}`,
  );

  // The host did the work before the answer was lost, so reconciliation has
  // something to find. The agent comes back and the next pass settles it.
  await agent.reconnect();

  const settled = await until('the interrupted create to be settled', async () => {
    const { body } = await api(session, '/api/v1/containers');
    const found = body.containers?.find((entry) => entry.name === unknownName);

    return found && found.management?.reconciling === false ? found : undefined;
  });

  check('reconciliation resolved it without repeating the operation', Boolean(settled));
  check(
    'and it ended up managed',
    settled?.management?.kind === 'managed',
    settled?.management?.kind,
  );

  const dispatches = (await agent.state()).received.filter(
    (capability) => capability === 'container.create',
  );

  check(
    'the create reached the host exactly twice, once per request',
    dispatches.length === 2,
    `${dispatches.length}`,
  );

  /*
   * Taking a container off the host without asking Dockplane.
   *
   * The scenarios that tell a gone container from a stale one need a host that
   * simply stops mentioning one, so the operation is proven here: it removes
   * the container it names and nothing else, and it leaves the inventory whole
   * so the next snapshot still counts as a complete observation.
   */
  const keep = await agent.seed(`harness-keep-${Date.now().toString(36)}`, {});
  const drop = await agent.seed(`harness-drop-${Date.now().toString(36)}`, {});

  const before = (await agent.state()).containers.map((entry) => entry.dockerId);

  check(
    'both seeded containers are on the host',
    before.includes(keep.dockerId) && before.includes(drop.dockerId),
  );

  await agent.removeContainer(drop.dockerId);

  const after = (await agent.state()).containers.map((entry) => entry.dockerId);

  check('the named container is gone from the host', !after.includes(drop.dockerId));
  check('and the other one is untouched', after.includes(keep.dockerId));

  let refused;
  try {
    await agent.removeContainer(drop.dockerId);
  } catch (error) {
    refused = error;
  }

  check('removing it twice is refused rather than silently accepted', Boolean(refused));

  const listed = await agent.state();

  check(
    'the host still answers a full inventory',
    Array.isArray(listed.containers) && listed.containers.length === after.length,
  );
} finally {
  await agent.stop();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}

console.log('\nthe harness path is sound');
