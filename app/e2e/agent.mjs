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
 * Starts an agent against an instance and waits until its host is connected.
 *
 * Enrolment and the connection are the real ones, so the host arrives in the
 * interface the same way a real machine's does.
 */
export async function startAgent(stack, { hostname = 'e2e-docker-01', session } = {}) {
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

    async stop() {
      await send('stop').catch(() => undefined);
      child.kill('SIGTERM');
    },
  };
}
