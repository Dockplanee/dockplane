/**
 * The test agent, as a browser suite uses it.
 *
 * A thin wrapper around a child process that does the actual work. The
 * simulator lives in the control server's own test tree because that is where
 * the gateway client, the certificate helpers and the capability catalog
 * already are — a second implementation of the agent protocol next to the
 * browser tests would drift from the first one silently.
 *
 * Everything here is control: start it, tell it what the host should look like,
 * arrange a lost answer or a refusal, and read back what the host holds. The
 * capability traffic itself goes over the real gateway and never through this.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const api = join(here, '..', '..', 'api');

/**
 * The host an agent belongs to, found by that agent's identity.
 *
 * The instance is shared by every suite in the run, and a suite that has
 * finished leaves its host behind as a record whose agent has gone. So a suite
 * cannot take whichever host it is offered first, and cannot go by name either:
 * a host is called what it reports about itself once its first inventory
 * arrives, and every test host reports the same thing. The agent's own
 * identifier is the only thing that distinguishes them.
 *
 * `connected` waits for the agent to finish connecting as well, which is what
 * an operation against the host needs — a host exists from the moment it
 * enrols, and a request sent before its agent is there is refused.
 */
export async function ownHost(base, session, agentId, { connected = false } = {}) {
  const deadline = Date.now() + 60_000;

  for (;;) {
    const response = await fetch(`${base}/api/v1/hosts`, { headers: { cookie: session.cookie } });
    const host = response.ok
      ? (await response.json()).hosts.find((entry) => entry.agent?.id === agentId)
      : undefined;

    if (host && (!connected || host.agent?.connected === true)) {
      return host.id;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for the host of agent ${agentId}${connected ? ' to be connected' : ' to be registered'}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Starts an agent against an instance and waits until its host is connected.
 *
 * Enrolment and the connection are the real ones, so the host arrives in the
 * interface the same way a real machine's does.
 */
/**
 * Names a host the way an operator does, and returns the token that carries it.
 *
 * The display name belongs to the setup, not to the enrolment: the control
 * server applies it to the host once the enrolment that setup produced has
 * completed. So the suite walks the same three steps the wizard walks — create
 * the setup, spend its ticket for an installation command, and read the setup
 * back afterwards, which is where the server settles it onto the host.
 */
export async function nameHost(stack, session, displayName) {
  const created = await fetch(`${stack.url}/api/v1/host-setups`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: stack.url,
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken,
    },
    body: JSON.stringify({ displayName }),
  });

  if (!created.ok) {
    throw new Error(`could not create a host setup: ${created.status} ${await created.text()}`);
  }

  const setup = await created.json();

  const script = await fetch(`${stack.url}/api/v1/host-setups/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: stack.url },
    body: JSON.stringify({ ticket: setup.ticket }),
  });

  if (!script.ok) {
    throw new Error(`could not spend the setup ticket: ${script.status} ${await script.text()}`);
  }

  // The command the operator would paste. The token is the one thing in it this
  // needs, and it is quoted, so the quotes are what delimit it.
  const token = /printf '%s' '([^']+)'/.exec(await script.text())?.[1];

  if (!token) {
    throw new Error('the installation command carried no enrollment token');
  }

  return { setupId: setup.id, token };
}

/** Settles a setup onto its host, which is what applies the chosen name. */
export async function settleHost(stack, session, setupId) {
  const answer = await fetch(`${stack.url}/api/v1/host-setups/${setupId}`, {
    headers: { cookie: session.cookie },
  });

  if (!answer.ok) {
    throw new Error(`could not read the host setup: ${answer.status}`);
  }

  return answer.json();
}

export async function startAgent(
  stack,
  { hostname = 'e2e-docker-01', session, enrollmentToken } = {},
) {
  const child = spawn('node', ['--import', 'tsx', join(api, 'test', 'browser-agent.ts')], {
    cwd: api,
    env: {
      ...process.env,
      DOCKPLANE_URL: stack.url,
      DOCKPLANE_EMAIL: stack.email,
      DOCKPLANE_PASSWORD: stack.password,
      DOCKPLANE_GATEWAY_PORT: String(stack.gatewayPort),
      DOCKPLANE_AGENT_CA_PEM: await readFile(stack.caCertPath, 'utf8'),
      DOCKPLANE_AGENT_HOSTNAME: hostname,
      ...(enrollmentToken ? { DOCKPLANE_AGENT_ENROLLMENT_TOKEN: enrollmentToken } : {}),
      // Handed the caller's session where there is one, so enrolling does not
      // spend another attempt against the sign-in rate limit.
      ...(session
        ? { DOCKPLANE_SESSION_COOKIE: session.cookie, DOCKPLANE_SESSION_CSRF: session.csrfToken }
        : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const pending = new Map();
  const events = [];
  let stopped = false;
  let ready;
  const readied = new Promise((resolve) => (ready = resolve));
  let next = 0;

  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;

    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.event === 'ready') {
      ready();
      return;
    }

    if (message.event) {
      events.push(message);
      return;
    }

    const waiting = pending.get(message.id);

    if (waiting) {
      pending.delete(message.id);
      message.ok ? waiting.resolve(message.result) : waiting.reject(new Error(message.error));
    }
  });

  child.on('exit', (code) => {
    for (const waiting of pending.values()) {
      waiting.reject(new Error(`the test agent exited with ${code}: ${stderr}`));
    }

    pending.clear();
  });

  const send = (command, extra = {}) =>
    new Promise((resolve, reject) => {
      const id = (next += 1);

      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, command, ...extra })}\n`);
    });

  await Promise.race([
    readied,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`the test agent did not start: ${stderr}`)), 30_000),
    ),
  ]);

  const identity = await send('start');

  return {
    ...identity,

    /** A container that was already on the host, with the labels it carries. */
    seed: (name, labels) => send('seed', { name, labels }),

    /** A Compose project the host already runs, which discovery will find. */
    seedProject: (name, services) => send('seedProject', { name, services }),

    /**
     * Takes a container off the host, as though somebody removed it there.
     *
     * By Docker id rather than name: a suite can have the same name on several
     * hosts, and the point of the scenarios that use this is telling those
     * hosts apart. The next complete inventory is what carries the news.
     */
    removeContainer: (dockerId) => send('removeContainer', { dockerId }),

    /**
     * Arranges one lost answer.
     *
     * `apply` says whether the host does the work before the connection goes,
     * which is the difference between a change that happened and one that did
     * not — indistinguishable to the server at the time, and settled the same
     * way afterwards.
     */
    dropNext: (capability, { apply = false } = {}) => send('dropNext', { capability, apply }),

    /** Arranges one refusal, the way an agent refuses. */
    failNext: (capability, code, message) => send('failNext', { capability, code, message }),

    /**
     * How the host behaves during the next stack apply.
     *
     * `wontStart` names services whose container comes up and stops;
     * `leaveHalfApplied` makes the host unable to put back what it moved, which
     * is the only way a stack ends up neither one revision nor another.
     */
    stackBehaviour: (options = {}) => send('stackBehaviour', options),

    reconnect: () => send('reconnect'),

    /** What the host holds now. Carries labels, never environment values. */
    state: () => send('state'),

    events,

    /**
     * Closes the connection and ends the process.
     *
     * Idempotent, because a suite that took a host away as part of a scenario
     * still stops every agent it started when it finishes. Asking a process
     * that has already gone would wait for an answer that cannot come.
     */
    async stop() {
      if (stopped) {
        return;
      }

      stopped = true;

      await Promise.race([
        send('stop').catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);

      child.kill('SIGTERM');
    },
  };
}
