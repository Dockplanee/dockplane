import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { AgentGatewayService } from '../src/agents/agent-gateway.service';
import { Database } from '../src/database/database';
import { DiscoveryService } from '../src/discovery/discovery.service';
import {
  agents,
  auditEntries,
  containers,
  stackDeployments,
  stackOperations,
  stackRevisionEnvironment,
  stackRevisions,
  stacks,
} from '../src/database/schema';
import { StackRecoveryService } from '../src/stacks/stack-recovery.service';
import { TestAgentConnection } from './agent-client';
import { createAgentCsr } from './agent-pki';
import { STACK_ATTRIBUTION_MINIMUM_AGENT_VERSION } from '../src/stacks/stack-attribution';
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

/** In a stack secret. Deleting a stack must never go anywhere near it. */
const CANARY = 'canary-stack-delete-1c0ffee';

/**
 * Deleting a stack.
 *
 * The destructive path, so most of what is checked here is what it refuses to
 * do and what it leaves behind. Volumes are kept on every path — that is the
 * difference between deleting a stack and deleting somebody's database — and
 * the saved configuration is removed only once the host has been read and
 * shows nothing claiming to be the stack any more.
 *
 * The order is the whole design: containers first, database second. A
 * configuration deleted first would leave containers whose identity nobody
 * could resolve, and identity is the only thing that makes them removable.
 */
describe('deleting a stack', () => {
  let app: INestApplication;
  let db: Database;
  let discovery: DiscoveryService;
  let stackRecovery: StackRecoveryService;
  let port: number;
  let caPem: string;
  let workspace: string;

  let host: FakeDockerHost;
  let connection: TestAgentConnection;
  let agentId: string;
  let hostId: string;
  let session: { cookie: string; csrf: string };

  let dispatched: string[] = [];
  let dropOn = new Set<string>();
  let dropAfter = new Set<string>();

  let credentials: { certificatePem: string; privateKeyPem: string };

  const signIn = async (roleName = 'Administrator') => {
    const user = await seedUser(db, {
      email: `user-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.internal`,
      roleName,
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

  const openConnection = async () => {
    const opened = await TestAgentConnection.open({ port, caPem, ...credentials });

    opened.send({
      type: 'hello',
      protocolVersion: 1,
      agentVersion: STACK_ATTRIBUTION_MINIMUM_AGENT_VERSION,
    });
    await opened.waitFor('hello_ack');

    opened.onMessage((message) => {
      if (message.type !== 'request') {
        return;
      }

      const capability = String(message.capability);

      dispatched.push(capability);

      if (dropOn.has(capability)) {
        opened.close();
        return;
      }

      let response: Record<string, unknown>;

      try {
        response = {
          status: 'success',
          payload: host.handle(capability, (message.payload ?? {}) as Record<string, unknown>),
        };
      } catch (error) {
        response = { status: 'error', error: error as { code: string; message: string } };
      }

      /*
       * The host did the work and the answer went with the socket. The
       * difference from `dropOn` is the whole point: one leaves the stack
       * exactly as it was and the other leaves it stopped, and the server has
       * to reach a different conclusion about each without being told which.
       */
      if (dropAfter.has(capability)) {
        opened.close();
        return;
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

  const connectAgent = async () => {
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

    return openConnection();
  };

  const reconnect = async () => {
    dropOn = new Set();
    dropAfter = new Set();
    connection = await openConnection();

    await new Promise((resolve) => setTimeout(resolve, 250));
  };

  const api = (method: 'get' | 'post' | 'delete', path: string, body?: unknown) => {
    const agent = request(app.getHttpServer());
    const call = (method === 'get' ? agent.get(path) : method === 'delete' ? agent.delete(path) : agent.post(path))
      .set('cookie', session.cookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', session.csrf);

    return body === undefined ? call : call.send(body as object);
  };

  const COMPOSE = [
    'services:',
    '  database:',
    '    image: postgres:17',
    '    environment:',
    '      POSTGRES_PASSWORD: ${DB_PASSWORD}',
    '    volumes:',
    '      - data:/var/lib/postgresql/data',
    '  web:',
    '    image: nginx:1.27',
    '    depends_on:',
    '      - database',
    'volumes:',
    '  data: {}',
  ].join('\n');

  const saveStack = async () => {
    const response = await api('post', '/api/v1/stacks', {
      name: `shop${Date.now().toString(36)}`,
      hostId,
      compose: COMPOSE,
      environment: [{ operation: 'set-secret', key: 'DB_PASSWORD', value: CANARY }],
    });

    expect(response.status).toBe(201);

    return {
      stackId: response.body.stackId as string,
      revisionId: response.body.revisionId as string,
    };
  };

  /** A stack that is deployed and running, which is where every test starts. */
  const deployed = async () => {
    const { stackId, revisionId } = await saveStack();
    const response = await api('post', `/api/v1/stacks/${stackId}/deploy`, { revisionId });

    expect(response.status).toBe(200);

    return { stackId, revisionId };
  };

  const stackRow = async (stackId: string) => {
    const [row] = await db.client.select().from(stacks).where(eq(stacks.id, stackId));

    return row;
  };

  const operationRows = async (stackId: string) =>
    db.client
      .select()
      .from(stackOperations)
      .where(eq(stackOperations.stackId, stackId))
      .orderBy(stackOperations.startedAt);

  const stackContainers = async (stackId: string) =>
    db.client.select().from(containers).where(eq(containers.stackId, stackId));

  /** What the host holds for this stack, by service. */
  const onHost = (stackId: string) =>
    new Map(
      [...host.containers.values()]
        .filter((container) => container.labels['io.dockplane.stack-id'] === stackId)
        .map((container) => [container.labels['io.dockplane.stack-service'], container]),
    );

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'dockplane-lifecycle-'));

    execFileSync('go', ['build', '-o', join(workspace, 'compose-compiler'), '.'], {
      cwd: join(__dirname, '..', '..', 'compose-compiler'),
      stdio: 'pipe',
    });

    process.env.DOCKPLANE_COMPOSE_COMPILER = join(workspace, 'compose-compiler');

    app = await createTestApp();
    db = app.get(Database);
    discovery = app.get(DiscoveryService);
    stackRecovery = app.get(StackRecoveryService);
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
    dispatched = [];
    dropOn = new Set();
    dropAfter = new Set();

    session = await signIn();
    connection = await connectAgent();

    const sync = await discovery.sync(agentId);
    hostId = sync.hostId;
  }, 120_000);

  afterEach(() => {
    connection?.close();
  });

  describe('a stack that was never deployed', () => {
    it('deletes it without asking a host for anything', async () => {
      const { stackId } = await saveStack();

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('deleted');

      expect(await stackRow(stackId)).toBeUndefined();
      expect(dispatched).not.toContain('stack.remove');
    }, 120_000);

    it('removes the saved configuration with it', async () => {
      const { stackId, revisionId } = await saveStack();

      await api('delete', `/api/v1/stacks/${stackId}`);

      // The Compose source and the encrypted environment go with the stack.
      expect(await db.client.select().from(stackRevisions).where(eq(stackRevisions.stackId, stackId)))
        .toHaveLength(0);
      expect(
        await db.client
          .select()
          .from(stackRevisionEnvironment)
          .where(eq(stackRevisionEnvironment.revisionId, revisionId)),
      ).toHaveLength(0);

      const gone = await api('get', `/api/v1/stacks/${stackId}`);

      expect(gone.status).toBe(404);
    }, 120_000);

    /*
     * A stack Dockplane believes never ran, whose containers are on the host.
     * Deleting the configuration would leave them with no identity anybody
     * could resolve them by, so it is refused instead.
     */
    it('refuses when the host holds containers claiming to be it', async () => {
      const { stackId } = await saveStack();

      await db.client
        .insert(containers)
        .values({
          hostId,
          dockerId: 'docker-somewhere',
          name: 'shop-web-1',
          image: 'nginx:1.27',
          state: 'running',
          stackId,
          stackService: 'web',
          observedAt: new Date(),
        });

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_STATE_AMBIGUOUS');
      expect(await stackRow(stackId)).toBeDefined();
    }, 120_000);
  });

  describe('a deployed stack', () => {
    it('removes its containers and then deletes it', async () => {
      const { stackId } = await deployed();

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('deleted');

      expect(onHost(stackId).size).toBe(0);
      expect(await stackRow(stackId)).toBeUndefined();
      expect(await stackContainers(stackId)).toHaveLength(0);
    }, 120_000);

    /* The rule with no exception, and the reason this operation is careful. */
    it('keeps the volumes and says which ones it kept', async () => {
      const { stackId } = await deployed();

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.body.retainedVolumes).toEqual(['data']);
      // The host still has it. Deleting a stack is not deleting data.
      expect(host.volumes.has('shop-data')).toBe(false);
      expect([...host.volumes].length).toBeGreaterThan(0);
    }, 120_000);

    it('takes services away in reverse dependency order', async () => {
      const { stackId } = await deployed();

      await api('delete', `/api/v1/stacks/${stackId}`);

      const [removal] = host.stackOperations.filter((entry) => entry.operation === 'remove');

      expect(removal.plan.services.find((service) => service.serviceName === 'web')?.dependsOn) //
        .toEqual(['database']);
    }, 120_000);

    /*
     * The path that has to work during an incident. A stack whose Compose
     * source no longer compiles is one an operator still needs to be able to
     * remove, so nothing here reads it.
     */
    it('needs no compiler and no Compose source', async () => {
      const { stackId } = await deployed();

      const compiler = process.env.DOCKPLANE_COMPOSE_COMPILER;
      process.env.DOCKPLANE_COMPOSE_COMPILER = join(workspace, 'no-such-compiler');

      try {
        const response = await api('delete', `/api/v1/stacks/${stackId}`);

        expect(response.status).toBe(200);
      } finally {
        process.env.DOCKPLANE_COMPOSE_COMPILER = compiler;
      }
    }, 120_000);

    it('sends the host nothing but identities', async () => {
      const { stackId } = await deployed();

      await api('delete', `/api/v1/stacks/${stackId}`);

      const [removal] = host.stackOperations.filter((entry) => entry.operation === 'remove');
      const sent = JSON.stringify(removal.plan);

      expect(sent).not.toContain(CANARY);
      expect(sent).not.toContain('POSTGRES_PASSWORD');
      expect(sent).not.toContain('image');
    }, 120_000);

    /* Deleting a stack does not deploy the newest thing saved first. */
    it('removes what is deployed, not what is newest', async () => {
      const { stackId, revisionId } = await deployed();

      await api('post', `/api/v1/stacks/${stackId}/revisions`, {
        baseRevisionId: revisionId,
        compose: COMPOSE.replace('nginx:1.27', 'nginx:1.28'),
        environment: [{ operation: 'unchanged', key: 'DB_PASSWORD' }],
      });

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(200);
      expect(host.received.filter((capability) => capability === 'stack.deploy')).toHaveLength(1);
      expect(onHost(stackId).size).toBe(0);
    }, 120_000);

    it('deletes a stopped stack without starting it', async () => {
      const { stackId } = await deployed();

      await api('post', `/api/v1/stacks/${stackId}/stop`);

      const before = host.received.filter((capability) => capability === 'stack.start').length;
      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(200);
      expect(host.received.filter((capability) => capability === 'stack.start')).toHaveLength(before);
      expect(await stackRow(stackId)).toBeUndefined();
    }, 120_000);
  });

  describe('what may not be deleted', () => {
    it('refuses a stack that needs attention', async () => {
      const { stackId } = await deployed();

      await db.client
        .update(stacks)
        .set({ status: 'needs_attention' })
        .where(eq(stacks.id, stackId));

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_NEEDS_ATTENTION');
      expect(await stackRow(stackId)).toBeDefined();
      expect(onHost(stackId).size).toBe(2);
    }, 120_000);

    it('refuses while an operation has not resolved', async () => {
      const { stackId, revisionId } = await deployed();

      await db.client.insert(stackOperations).values({
        stackId,
        revisionId,
        hostId,
        type: 'stop',
        status: 'interrupted',
      });

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_OPERATION_CONFLICT');
      expect(await stackRow(stackId)).toBeDefined();
    }, 120_000);

    it('refuses while a deployment has not resolved', async () => {
      const { stackId, revisionId } = await deployed();

      await db.client.insert(stackDeployments).values({
        stackId,
        revisionId,
        hostId,
        kind: 'redeploy',
        status: 'interrupted',
      });

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_DEPLOYMENT_CONFLICT');
    }, 120_000);

    it('refuses somebody without the permission', async () => {
      const { stackId } = await deployed();

      session = await signIn('Operator');

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(403);
      expect(await stackRow(stackId)).toBeDefined();
    }, 120_000);

    it('refuses a stack whose service has no container on the host', async () => {
      const { stackId } = await deployed();

      const [container] = await stackContainers(stackId);

      await db.client
        .update(containers)
        .set({ dockerId: null })
        .where(eq(containers.id, container.id));

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_SERVICE_MISSING');
      expect(await stackRow(stackId)).toBeDefined();
    }, 120_000);
  });

  describe('an answer that never came back', () => {
    it('deletes nothing and repeats nothing', async () => {
      const { stackId } = await deployed();

      dropAfter = new Set(['stack.remove']);

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('OPERATION_OUTCOME_UNKNOWN');

      // Nothing is deleted while nobody knows what the host did.
      expect(await stackRow(stackId)).toBeDefined();
      expect(dispatched.filter((capability) => capability === 'stack.remove')).toHaveLength(1);
    }, 120_000);

    it('finishes a removal that reached the host', async () => {
      const { stackId } = await deployed();

      dropAfter = new Set(['stack.remove']);

      await api('delete', `/api/v1/stacks/${stackId}`);
      await reconnect();

      expect(await stackRecovery.recoverHost(hostId)).toBe(1);

      expect(await stackRow(stackId)).toBeUndefined();
      expect(dispatched.filter((capability) => capability === 'stack.remove')).toHaveLength(1);
    }, 120_000);

    it('keeps a stack whose removal never reached the host', async () => {
      const { stackId } = await deployed();

      dropOn = new Set(['stack.remove']);

      await api('delete', `/api/v1/stacks/${stackId}`);
      await reconnect();

      expect(await stackRecovery.recoverHost(hostId)).toBe(1);

      expect(await stackRow(stackId)).toBeDefined();
      expect(onHost(stackId).size).toBe(2);

      const [operation] = await operationRows(stackId);

      expect(operation.status).toBe('failed');
      expect(operation.failureCode).toBe('STACK_DELETE_FAILED');
    }, 120_000);

    it('blocks the stack until the removal is settled', async () => {
      const { stackId } = await deployed();

      dropAfter = new Set(['stack.remove']);

      await api('delete', `/api/v1/stacks/${stackId}`);
      await reconnect();

      const blocked = await api('post', `/api/v1/stacks/${stackId}/stop`);

      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('STACK_OPERATION_CONFLICT');
    }, 120_000);
  });

  describe('a stack left half removed', () => {
    /*
     * Nothing is rebuilt and nothing is deleted. The configuration is what
     * somebody resolving this will work from, so it is the last thing to go.
     */
    it('says the stack needs attention and keeps everything', async () => {
      const { stackId } = await deployed();

      host.wontRemove.add('database');

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_DELETE_PARTIAL');

      const stack = await stackRow(stackId);

      expect(stack.status).toBe('needs_attention');
      expect(
        await db.client.select().from(stackRevisions).where(eq(stackRevisions.stackId, stackId)),
      ).not.toHaveLength(0);

      const [operation] = await operationRows(stackId);

      expect(operation.status).toBe('needs_attention');
    }, 120_000);

    it('cannot be deleted again until somebody applies a revision', async () => {
      const { stackId } = await deployed();

      host.wontRemove.add('database');
      await api('delete', `/api/v1/stacks/${stackId}`);

      const blocked = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('STACK_NEEDS_ATTENTION');
    }, 120_000);
  });

  describe('what is written down', () => {
    it('records the deletion in a trail that survives the stack', async () => {
      const { stackId } = await deployed();

      await api('delete', `/api/v1/stacks/${stackId}`);

      const recorded = await db.client.select().from(auditEntries);
      const kinds = recorded.map((entry) => entry.action);

      expect(kinds).toContain('stack.delete.requested');
      expect(kinds).toContain('stack.deleted');

      // The stack is gone and the trail still names it.
      const deletion = recorded.find((entry) => entry.action === 'stack.deleted');

      expect(deletion?.targetId).toBe(stackId);
      expect(deletion?.targetLabel).toBeTruthy();
      expect(JSON.stringify(recorded)).not.toContain(CANARY);
    }, 120_000);

    it('leaves no stack behind in the listing', async () => {
      const { stackId } = await deployed();

      await api('delete', `/api/v1/stacks/${stackId}`);

      const listed = await api('get', '/api/v1/stacks');

      expect(listed.body.stacks.map((stack: { id: string }) => stack.id)).not.toContain(stackId);
      expect(listed.body.page.total).toBe(0);
    }, 120_000);
  });
  /*
   * An agent that predates stack attribution, which is every agent before
   * 0.3.0-rc.2.
   *
   * Those agents set the stack labels on the containers they create and do not
   * forward them, so the control server holds their containers with no stack at
   * all. Everything below turns on what the server does when the absence of an
   * attribution is not evidence of an absent container.
   */
  describe('a host whose agent does not report stack attribution', () => {
    const ageTheAgent = async (version: string | null) => {
      await db.client.update(agents).set({ version }).where(eq(agents.id, agentId));
    };

    it('is refused before the host is asked to remove anything', async () => {
      const { stackId } = await deployed();

      await ageTheAgent('0.2.0');
      host.received.length = 0;

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('AGENT_UPGRADE_REQUIRED');
      expect(host.received).not.toContain('stack.remove');

      // The stack is still there to be removed once the agent can be trusted.
      const [stack] = await db.client.select().from(stacks).where(eq(stacks.id, stackId));

      expect(stack).toBeDefined();
    }, 120_000);

    /*
     * The case that made this necessary. A deployment that was dispatched but
     * never finalised leaves the stack with no confirmed revision, which is the
     * same shape as a stack nobody ever deployed — and that one is deleted
     * without asking the host, on the strength of no container claiming it.
     * With an agent that cannot claim, that strength is nothing.
     */
    it('will not call a stack undeployed on the word of an agent that cannot say', async () => {
      const { stackId } = await deployed();

      // What the defect produced: containers running, no attribution recorded,
      // and no revision confirmed.
      await db.client.update(containers).set({ stackId: null }).where(eq(containers.stackId, stackId));
      await db.client.update(stacks).set({ currentRevisionId: null }).where(eq(stacks.id, stackId));
      await ageTheAgent('0.2.0');
      host.received.length = 0;

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('AGENT_UPGRADE_REQUIRED');
      expect(host.received).not.toContain('stack.remove');

      const [stack] = await db.client.select().from(stacks).where(eq(stacks.id, stackId));

      expect(stack).toBeDefined();
    }, 120_000);

    it('refuses an agent that has never said what it is', async () => {
      const { stackId } = await deployed();

      await ageTheAgent(null);

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('AGENT_UPGRADE_REQUIRED');
    }, 120_000);

    /*
     * A configuration nobody ever deployed cannot have left anything on a host,
     * whatever that host is running. Refusing it too would strand a stack that
     * was only ever a draft.
     */
    it('still deletes a stack that was never dispatched', async () => {
      const { stackId } = await saveStack();

      await ageTheAgent('0.2.0');

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(200);

      const [stack] = await db.client.select().from(stacks).where(eq(stacks.id, stackId));

      expect(stack).toBeUndefined();
    }, 120_000);

    it('removes it properly once the agent has been upgraded', async () => {
      const { stackId } = await deployed();

      await ageTheAgent('0.2.0');
      expect((await api('delete', `/api/v1/stacks/${stackId}`)).status).toBe(409);

      await ageTheAgent('0.3.0-rc.2');
      host.received.length = 0;

      const response = await api('delete', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(200);
      expect(host.received).toContain('stack.remove');

      const remaining = [...host.containers.values()].filter((container) =>
        container.labels['io.dockplane.stack-id'] === stackId,
      );

      expect(remaining).toHaveLength(0);
    }, 120_000);
  });
});
