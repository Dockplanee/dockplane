/**
 * An agent for the browser tests, and nothing else.
 *
 * The browser suites run against an instance built for the run: a database, the
 * real control server, and one origin serving the built application. What that
 * instance has never had is a host — so every request that changes a container
 * was refused before it reached anything worth testing.
 *
 * This supplies one. It enrolls the way an agent enrolls, connects to the real
 * gateway over mTLS with a certificate the real CA issued, and answers real
 * capability requests. What it does not have is Docker: behind it is the same
 * in-memory host model the API tests use, so a create adds a container, a
 * replace exchanges one, and the next inventory pass is how the server finds
 * out. Everything between the browser and here is production code.
 *
 * Deliberately not Docker-in-Docker. The Docker side is covered by the agent's
 * own integration suite against a real daemon; repeating it here would buy
 * nothing and cost privileges, runtime and flakiness in the browser tests.
 *
 * Test-only, and only reachable as a child process of the browser harness:
 *
 *   node --import tsx test/browser-agent.ts
 *
 * It takes its instructions on stdin and answers on stdout, one JSON object per
 * line. There is no route into the product that does any of this.
 */
import { createInterface } from 'node:readline';

import { CAPABILITIES } from '../src/agents/capabilities';
import { PROTOCOL_VERSION } from '../src/agents/protocol';
import { TestAgentConnection } from './agent-client';
import { createAgentCsr } from './agent-pki';
import { FakeDockerHost } from './docker-host';

interface Command {
  readonly id: number;
  readonly command: string;
  readonly [key: string]: unknown;
}

const origin = required('DOCKPLANE_URL');
const email = required('DOCKPLANE_EMAIL');
const password = required('DOCKPLANE_PASSWORD');
const gatewayPort = Number(required('DOCKPLANE_GATEWAY_PORT'));
const caPem = required('DOCKPLANE_AGENT_CA_PEM');
const hostname = process.env.DOCKPLANE_AGENT_HOSTNAME ?? 'e2e-docker-01';

const host = new FakeDockerHost();

/** Capabilities to answer by losing the connection instead of replying. */
const dropOn = new Map<string, { apply: boolean }>();

/** Capabilities to refuse the way an agent refuses. */
const failOn = new Map<string, { code: string; message: string }>();

let credentials: { certificatePem: string; privateKeyPem: string } | undefined;
let connection: TestAgentConnection | undefined;
let agentId = '';

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function say(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * A session to enrol with.
 *
 * Reuses the caller's when it has one. Signing in again would be a second
 * attempt against the credentials rate limit the control server applies to
 * everyone, and a browser suite that ran afterwards would pay for it.
 */
async function session(): Promise<{ cookie: string; csrf: string }> {
  const cookie = process.env.DOCKPLANE_SESSION_COOKIE;
  const csrf = process.env.DOCKPLANE_SESSION_CSRF;

  if (cookie && csrf) {
    return { cookie, csrf };
  }

  const answer = await fetch(`${origin}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, password }),
  });

  if (!answer.ok) {
    throw new Error(`sign-in failed: ${answer.status}`);
  }

  const issued = (answer.headers.getSetCookie() ?? [])
    .find((entry) => entry.startsWith('dockplane_session='))
    ?.split(';')[0];

  if (!issued) {
    throw new Error('sign-in returned no session cookie');
  }

  return { cookie: issued, csrf: ((await answer.json()) as { csrfToken: string }).csrfToken };
}

/**
 * Enrols through the real endpoints.
 *
 * The host and the agent identity are created by enrolment, exactly as they are
 * for a real machine. Nothing writes "connected" into the database directly:
 * the gateway decides that when the connection is established, which is the
 * part worth testing.
 */
async function enrol(): Promise<void> {
  const { cookie, csrf } = await session();

  const token = await fetch(`${origin}/api/v1/agents/enrollment-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({ intendedHostname: hostname }),
  });

  if (!token.ok) {
    throw new Error(`could not create an enrollment token: ${token.status}`);
  }

  const { csrPem, privateKeyPem } = await createAgentCsr();

  const enrolled = await fetch(`${origin}/api/v1/agent-enrollments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({
      token: ((await token.json()) as { token: string }).token,
      csr: csrPem,
      protocolVersion: PROTOCOL_VERSION,
      hostname,
    }),
  });

  if (!enrolled.ok) {
    throw new Error(`enrollment failed: ${enrolled.status}`);
  }

  const body = (await enrolled.json()) as { agentId: string; certificate: string };

  agentId = body.agentId;
  credentials = { certificatePem: body.certificate, privateKeyPem };
}

/** Opens the gateway connection and answers what the server asks for. */
async function connect(): Promise<void> {
  if (!credentials) {
    throw new Error('not enrolled');
  }

  const opened = await TestAgentConnection.open({ port: gatewayPort, caPem, ...credentials });

  opened.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
  await opened.waitFor('hello_ack');

  opened.onMessage((message) => {
    if (message.type !== 'request') {
      return;
    }

    const capability = String(message.capability);
    const payload = (message.payload ?? {}) as Record<string, unknown>;

    /*
     * The outcome the server cannot learn.
     *
     * The request arrived; whether Docker acted on it is what the connection
     * took with it. Both halves are worth testing, so the scenario says which
     * one this is: a host that did the work and a host that did not are
     * indistinguishable to the server at this moment and are settled the same
     * way, by reading the host afterwards.
     */
    const drop = dropOn.get(capability);

    if (drop) {
      dropOn.delete(capability);

      if (drop.apply) {
        try {
          host.handle(capability, payload);
        } catch {
          // A host that could not do it either way is still a lost answer.
        }
      }

      say({ event: 'dropped', capability, applied: drop.apply });
      opened.close();
      connection = undefined;

      return;
    }

    const failure = failOn.get(capability);

    if (failure) {
      failOn.delete(capability);

      opened.send({
        type: 'response',
        protocolVersion: PROTOCOL_VERSION,
        id: message.id,
        capability: message.capability,
        status: 'error',
        error: failure,
      });

      return;
    }

    try {
      opened.send({
        type: 'response',
        protocolVersion: PROTOCOL_VERSION,
        id: message.id,
        capability: message.capability,
        status: 'success',
        payload: host.handle(capability, payload),
      });
    } catch (error) {
      opened.send({
        type: 'response',
        protocolVersion: PROTOCOL_VERSION,
        id: message.id,
        capability: message.capability,
        status: 'error',
        error: error as { code: string; message: string },
      });
    }
  });

  connection = opened;
}

/**
 * What the simulator can answer, checked against the server's own catalog.
 *
 * A capability the browser tests rely on that the product no longer defines
 * would otherwise be discovered as a browser test passing against something
 * that does not exist. The list is derived from the catalog rather than written
 * out again beside it.
 */
const SUPPORTED = [
  'host.inventory',
  'host.metrics',
  'container.list',
  'container.inspect',
  'container.start',
  'container.stop',
  'container.restart',
  'container.create',
  'container.replace',
  'container.remove',
  'compose.list',
] as const;

function checkProtocol(): string[] {
  const catalog = new Set<string>(CAPABILITIES);

  return SUPPORTED.filter((capability) => !catalog.has(capability));
}

const commands: Record<string, (command: Command) => Promise<unknown> | unknown> = {
  /** Enrols and connects. The host is reachable from here on. */
  async start() {
    const drift = checkProtocol();

    if (drift.length > 0) {
      throw new Error(`the simulator answers capabilities the server does not define: ${drift}`);
    }

    await enrol();
    await connect();

    return { agentId, hostname, protocolVersion: PROTOCOL_VERSION };
  },

  /** Comes back after a lost connection, as a reconnecting agent does. */
  async reconnect() {
    await connect();

    return { connected: true };
  },

  /** A container that was already on the host when Dockplane arrived. */
  seed(command: Command) {
    const container = host.seed(
      String(command.name),
      (command.labels ?? {}) as Record<string, string>,
    );

    return { dockerId: container.dockerId };
  },

  /** The next request for this capability loses its answer. */
  dropNext(command: Command) {
    dropOn.set(String(command.capability), { apply: Boolean(command.apply) });

    return { armed: String(command.capability) };
  },

  /** The next request for this capability is refused, the way an agent refuses. */
  failNext(command: Command) {
    failOn.set(String(command.capability), {
      code: String(command.code ?? 'DOCKER_OPERATION_FAILED'),
      message: String(command.message ?? 'The operation failed on the host.'),
    });

    return { armed: String(command.capability) };
  },

  /**
   * What the host holds.
   *
   * Labels are included because the identity a container carries is what the
   * server reconciles by. Environment is not: the value of a secret has no
   * reason to exist in a test's output.
   */
  state() {
    return {
      containers: [...host.containers.values()].map((container) => ({
        dockerId: container.dockerId,
        name: container.name,
        image: container.image,
        state: container.state,
        labels: container.labels,
      })),
      received: host.received,
    };
  },

  stop() {
    connection?.close();
    connection = undefined;

    return { stopped: true };
  },
};

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) {
    return;
  }

  const command = JSON.parse(line) as Command;

  void (async () => {
    try {
      say({ id: command.id, ok: true, result: await commands[command.command]?.(command) });
    } catch (error) {
      say({ id: command.id, ok: false, error: error instanceof Error ? error.message : 'failed' });
    }
  })();
});

say({ event: 'ready' });
