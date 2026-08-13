import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { AgentGatewayService } from '../src/agents/agent-gateway.service';
import { CAPABILITIES } from '../src/agents/capabilities';
import { Database } from '../src/database/database';
import { agents, auditEntries, containers, stackDeployments, stacks } from '../src/database/schema';
import { DiscoveryService } from '../src/discovery/discovery.service';
import { TestAgentConnection } from './agent-client';
import { createAgentCsr } from './agent-pki';
import { FakeDockerHost } from './docker-host';
import {
  DEFAULT_PASSWORD,
  createTestApp,
  resetData,
  resetThrottling,
  seedUser,
  testPki,
} from './app';

const ORIGIN = 'http://localhost:4200';
const RELEASE = 'v0.1.0';
const REPOSITORY = join(__dirname, '..', '..');

/**
 * A control plane running this version with agents that are still on 0.1.0.
 *
 * Upgrading a fleet is not atomic. The control plane goes first — it is one
 * machine — and the agents follow over days, so for as long as that takes this
 * server is asking hosts for things some of them have never heard of. What
 * matters is that the answer is a plain refusal rather than a stack recorded as
 * deployed on a host that did nothing, and that everything 0.1.0 could already
 * do goes on working untouched.
 *
 * The older agent's capability set is read out of its own release rather than
 * written down here, so it cannot quietly drift into being this version's.
 */
function releaseCapabilities(): string[] {
  let source: string;

  try {
    source = execFileSync('git', ['show', `${RELEASE}:api/src/agents/capabilities.ts`], {
      cwd: REPOSITORY,
      encoding: 'utf8',
    });
  } catch {
    throw new Error(
      `${RELEASE} is not in this checkout, so compatibility with the agent it shipped cannot ` +
        `be tested. Fetch the tags (git fetch --tags) and run this again.`,
    );
  }

  const block = /export const CAPABILITIES = \[([\s\S]*?)\] as const;/.exec(source);

  if (!block) {
    throw new Error(`${RELEASE} does not declare a capability catalog in the expected shape`);
  }

  return [...block[1].matchAll(/'([a-z.]+)'/g)].map((match) => match[1]);
}

describe('a control server this version with an agent from 0.1.0', () => {
  const OLDER = releaseCapabilities();

  let app: INestApplication;
  let db: Database;
  let discovery: DiscoveryService;
  let port: number;
  let caPem: string;
  let workspace: string;

  let host: FakeDockerHost;
  let connection: TestAgentConnection;
  let agentId: string;
  let hostId: string;
  let session: { cookie: string; csrf: string };
  let credentials: { certificatePem: string; privateKeyPem: string };

  const signIn = async () => {
    const user = await seedUser(db, {
      email: `user-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.internal`,
      roleName: 'Administrator',
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('origin', ORIGIN)
      .send({ email: user.email, password: DEFAULT_PASSWORD });

    const raw = response.headers['set-cookie'] as unknown as string[];

    return {
      cookie: raw.find((entry) => entry.startsWith('dockplane_session='))!.split(';')[0],
      csrf: response.body.csrfToken as string,
    };
  };

  /** An agent that says what it is and answers only for what that release had. */
  const connectAgent = async (advertised: readonly string[] = OLDER) => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/agents/enrollment-tokens')
      .set('cookie', session.cookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', session.csrf)
      .send({ intendedHostname: 'docker-01' });

    const { csrPem, privateKeyPem } = await createAgentCsr();

    const enrolled = await request(app.getHttpServer())
      .post('/api/v1/agent-enrollments')
      .send({ token: created.body.token, csr: csrPem, protocolVersion: 1, hostname: 'docker-01' });

    agentId = enrolled.body.agentId;
    credentials = { certificatePem: enrolled.body.certificate, privateKeyPem };

    const opened = await TestAgentConnection.open({ port, caPem, ...credentials });

    opened.send({
      type: 'hello',
      protocolVersion: 1,
      agentVersion: '0.1.0',
      capabilities: advertised,
    });

    await opened.waitFor('hello_ack');

    opened.onMessage((message) => {
      if (message.type !== 'request') {
        return;
      }

      let response: Record<string, unknown>;

      try {
        response = {
          status: 'success',
          payload: host.handle(
            String(message.capability),
            (message.payload ?? {}) as Record<string, unknown>,
          ),
        };
      } catch (error) {
        response = { status: 'error', error: error as { code: string; message: string } };
      }

      opened.send({
        type: 'response',
        protocolVersion: 1,
        id: message.id,
        capability: message.capability,
        ...response,
      });
    });

    return opened;
  };

  const api = (method: 'get' | 'post', path: string, body?: unknown) => {
    const agent = request(app.getHttpServer());
    const call = (method === 'get' ? agent.get(path) : agent.post(path))
      .set('cookie', session.cookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', session.csrf);

    return body === undefined ? call : call.send(body as object);
  };

  const COMPOSE = ['services:', '  web:', '    image: nginx:1.27'].join('\n');

  const saveStack = async () => {
    const response = await api('post', '/api/v1/stacks', {
      name: `shop${Date.now().toString(36)}`,
      hostId,
      compose: COMPOSE,
      environment: [],
    });

    expect(response.status).toBe(201);

    return {
      stackId: response.body.stackId as string,
      revisionId: response.body.revisionId as string,
    };
  };

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'dockplane-mixed-'));

    execFileSync('go', ['build', '-o', join(workspace, 'compose-compiler'), '.'], {
      cwd: join(REPOSITORY, 'compose-compiler'),
      stdio: 'pipe',
    });

    process.env.DOCKPLANE_COMPOSE_COMPILER = join(workspace, 'compose-compiler');

    app = await createTestApp();
    db = app.get(Database);
    discovery = app.get(DiscoveryService);
    port = app.get(AgentGatewayService).port;
    caPem = (await testPki()).caCertPem;
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    rmSync(workspace, { recursive: true, force: true });
    delete process.env.DOCKPLANE_COMPOSE_COMPILER;
  });

  beforeEach(async () => {
    await resetData(db);
    resetThrottling(app);

    host = new FakeDockerHost();

    // Everything this version added, and nothing that release had.
    for (const capability of CAPABILITIES) {
      if (!OLDER.includes(capability)) {
        host.unsupported.add(capability);
      }
    }

    session = await signIn();
    connection = await connectAgent();

    const sync = await discovery.sync(agentId);
    hostId = sync.hostId;
  }, 120_000);

  afterEach(() => {
    connection?.close();
  });

  it('is the same protocol, so the agent connects and is recorded as it is', async () => {
    const [agent] = await db.client.select().from(agents).where(eq(agents.id, agentId));

    expect(agent.protocolVersion).toBe(1);
    expect(agent.status).toBe('connected');
    expect(agent.version).toBe('0.1.0');
    expect(agent.capabilities).toEqual(OLDER);
  });

  /*
   * A host does not get to name capabilities this server has never had. The
   * value is read back through the API, so an agent that could put anything
   * there would be writing into the control server's own vocabulary.
   */
  it('records only capabilities it knows, whatever the agent claims', async () => {
    connection.close();
    await resetData(db);

    session = await signIn();
    connection = await connectAgent([...OLDER, 'shell.execute', 'host.wipe']);

    const [agent] = await db.client.select().from(agents).where(eq(agents.id, agentId));

    expect(agent.capabilities).toEqual(OLDER);
  });

  /*
   * The direction that has to keep working without any coordination: this
   * version asks 0.1.0 agents for nothing 0.1.0 did not already serve, so an
   * agent upgraded ahead of its control plane is equally safe.
   */
  it('still offers every capability that release had', () => {
    expect(CAPABILITIES).toEqual(expect.arrayContaining(OLDER));
  });

  describe('what 0.1.0 could already do', () => {
    beforeEach(() => {
      host.seed('shop-web-1');
    });

    it('discovers the host and its containers', async () => {
      await discovery.sync(agentId);

      const response = await api('get', `/api/v1/containers?hostId=${hostId}`);

      expect(response.status).toBe(200);
      expect(response.body.containers).toHaveLength(1);
      expect(response.body.containers[0].name).toBe('shop-web-1');
    });

    it('restarts a container', async () => {
      await discovery.sync(agentId);

      const [container] = await db.client
        .select()
        .from(containers)
        .where(eq(containers.hostId, hostId));

      const response = await api('post', `/api/v1/containers/${container.id}/restart`);

      expect(response.status).toBe(200);
      expect(host.received).toContain('container.restart');
    });
  });

  describe('what this version added', () => {
    it('refuses to deploy a stack, and says the host cannot do it', async () => {
      const { stackId, revisionId } = await saveStack();

      const response = await api('post', `/api/v1/stacks/${stackId}/deploy`, { revisionId });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('AGENT_CAPABILITY_UNSUPPORTED');
      expect(response.body.message).toBe('This host does not support that operation.');
    });

    /*
     * Nothing was applied, so nothing is recorded as applied. The distinction
     * that matters on an upgrade: this is a refusal, not an unknown outcome,
     * and it must not leave a stack that needs somebody to look at it.
     */
    it('leaves the stack exactly as it was', async () => {
      const { stackId, revisionId } = await saveStack();

      await api('post', `/api/v1/stacks/${stackId}/deploy`, { revisionId });

      const [stack] = await db.client.select().from(stacks).where(eq(stacks.id, stackId));

      expect(stack.status).toBe('not_deployed');
      expect(stack.currentRevisionId).toBeNull();
      expect(
        await db.client.select().from(containers).where(eq(containers.stackId, stackId)),
      ).toEqual([]);
    });

    /* And the attempt is settled, so the same stack can be deployed again once
     * the agent has been upgraded. */
    it('does not leave the stack blocked behind an unresolved attempt', async () => {
      const { stackId, revisionId } = await saveStack();

      await api('post', `/api/v1/stacks/${stackId}/deploy`, { revisionId });

      const [attempt] = await db.client
        .select()
        .from(stackDeployments)
        .where(eq(stackDeployments.stackId, stackId));

      expect(attempt.status).toBe('failed');
      expect(attempt.resolvedAt).not.toBeNull();

      const again = await api('post', `/api/v1/stacks/${stackId}/deploy`, { revisionId });

      expect(again.body.code).not.toBe('STACK_DEPLOYMENT_CONFLICT');
    });

    it('refuses to create a container the same way', async () => {
      const response = await api('post', '/api/v1/containers', {
        hostId,
        name: 'lonely',
        image: 'nginx:1.27',
      });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('AGENT_CAPABILITY_UNSUPPORTED');
    });

    it('records the refusal in the audit trail', async () => {
      const { stackId, revisionId } = await saveStack();

      await api('post', `/api/v1/stacks/${stackId}/deploy`, { revisionId });

      const entries = await db.client.select().from(auditEntries);
      const refused = entries.filter(
        (entry) => entry.action.startsWith('stack.deploy') && entry.result === 'failure',
      );

      expect(refused).not.toHaveLength(0);
      expect(refused[0].targetType).toBe('stack');
    });
  });
});
