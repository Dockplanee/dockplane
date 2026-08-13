import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { AgentGatewayService } from '../src/agents/agent-gateway.service';
import { Database } from '../src/database/database';
import { DiscoveryService } from '../src/discovery/discovery.service';
import {
  actions,
  auditEntries,
  containers,
  events,
  stackDeployments,
  stacks,
} from '../src/database/schema';
import { StackRecoveryService } from '../src/stacks/stack-recovery.service';
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

/** In a stack secret. Belongs in the plan and nowhere else. */
const CANARY = 'canary-stack-deploy-1c0ffee';

/**
 * Deploying a stack for the first time, end to end.
 *
 * A real mTLS connection in front of a small model of a Docker host, so that
 * every conclusion the server reaches comes from listing that host again rather
 * than from an agent's reply. A deployment that half-happened, a host that
 * accepted the request and lost its answer, and a container somebody else owns
 * are all states these tests arrange.
 *
 * The rules under scrutiny: a stack is recorded as deployed only after its
 * containers were read back off the host; a partial deployment removes nothing
 * and blocks the stack until a person looks; and the resolved values a plan
 * carries reach the agent and nothing else.
 */
describe('deploying a stack', () => {
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
  /** Capabilities the host never sees: the connection dies on arrival. */
  let dropOn = new Set<string>();
  /** Capabilities the host performs and then loses its connection over. */
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

    opened.send({ type: 'hello', protocolVersion: 1 });
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
       * difference from `dropOn` is the whole point: one leaves nothing on the
       * host and the other leaves a running stack, and the server has to reach
       * a different conclusion about each without being told which happened.
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

    // The gateway registers the connection a moment after the handshake.
    await new Promise((resolve) => setTimeout(resolve, 250));
  };

  const api = (method: 'get' | 'post', path: string, body?: unknown) => {
    const agent = request(app.getHttpServer());
    const call = (method === 'get' ? agent.get(path) : agent.post(path))
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

  /** A saved stack of two services, one depending on the other. */
  const saveStack = async (compose = COMPOSE) => {
    const response = await api('post', '/api/v1/stacks', {
      name: `shop${Date.now().toString(36)}`,
      hostId,
      compose,
      environment: [{ operation: 'set-secret', key: 'DB_PASSWORD', value: CANARY }],
    });

    expect(response.status).toBe(201);

    return {
      stackId: response.body.stackId as string,
      revisionId: response.body.revisionId as string,
    };
  };

  const deploy = (stackId: string, revisionId: string) =>
    api('post', `/api/v1/stacks/${stackId}/deploy`, { revisionId });

  const deployed = async () => {
    const { stackId, revisionId } = await saveStack();
    const response = await deploy(stackId, revisionId);

    return { stackId, revisionId, response };
  };

  const stackRow = async (stackId: string) => {
    const [row] = await db.client.select().from(stacks).where(eq(stacks.id, stackId));

    return row;
  };

  const deploymentRow = async (stackId: string) => {
    const [row] = await db.client
      .select()
      .from(stackDeployments)
      .where(eq(stackDeployments.stackId, stackId));

    return row;
  };

  const stackContainers = async (stackId: string) =>
    db.client.select().from(containers).where(eq(containers.stackId, stackId));

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'dockplane-deploy-'));

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

  describe('a stack that has never run', () => {
    it('creates every service and records the revision as deployed', async () => {
      const { stackId, revisionId, response } = await deployed();

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('succeeded');
      expect(
        response.body.services.map((service: { serviceName: string }) => service.serviceName),
      ).toEqual(['database', 'web']);

      const stack = await stackRow(stackId);

      // Set from what was read back off the host, not from the reply.
      expect(stack.currentRevisionId).toBe(revisionId);
      expect(stack.status).toBe('running');
      expect(stack.lastDeployedAt).not.toBeNull();
      expect(stack.desiredRevisionId).toBeNull();

      const deployment = await deploymentRow(stackId);

      expect(deployment.status).toBe('succeeded');
      expect(deployment.kind).toBe('initial');
      expect(deployment.resolvedAt).not.toBeNull();
    }, 120_000);

    it('starts a service after the one it depends on', async () => {
      await deployed();

      const created = [...host.containers.values()].map(
        (container) => container.labels['io.dockplane.stack-service'],
      );

      expect(created).toEqual(['database', 'web']);
    }, 120_000);

    it('stamps the stack, revision and service onto every container', async () => {
      const { stackId, revisionId } = await deployed();
      const rows = await stackContainers(stackId);

      expect(rows).toHaveLength(2);

      for (const row of rows) {
        expect(row.dockerId).not.toBeNull();
        expect(row.state).toBe('running');
        expect(['database', 'web']).toContain(row.stackService);

        const container = host.containers.get(row.dockerId!)!;

        expect(container.labels['io.dockplane.stack-id']).toBe(stackId);
        expect(container.labels['io.dockplane.stack-revision-id']).toBe(revisionId);
        expect(container.labels['io.dockplane.container-id']).toBe(row.id);
      }
    }, 120_000);

    it('asks for the volumes the file declares, under the names Compose uses', async () => {
      const { stackId } = await deployed();
      const stack = await stackRow(stackId);

      expect([...host.volumes]).toEqual([`${stack.name}_data`]);
    }, 120_000);

    it('refuses to deploy it a second time', async () => {
      const { stackId, revisionId } = await deployed();
      const again = await deploy(stackId, revisionId);

      expect(again.status).toBe(409);
      expect(again.body.code).toBe('STACK_ALREADY_DEPLOYED');
    }, 120_000);

    it('refuses a revision that is not the newest', async () => {
      const { stackId, revisionId } = await saveStack();

      const second = await api('post', `/api/v1/stacks/${stackId}/revisions`, {
        baseRevisionId: revisionId,
        compose: COMPOSE.replace('nginx:1.27', 'nginx:1.28'),
        environment: [{ operation: 'unchanged', key: 'DB_PASSWORD' }],
      });

      expect(second.status).toBe(201);

      const response = await deploy(stackId, revisionId);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_REVISION_CONFLICT');
      expect(dispatched).not.toContain('stack.deploy');
    }, 120_000);
  });

  describe('what the request may say', () => {
    it('takes a revision and nothing else', async () => {
      const { stackId, revisionId } = await saveStack();

      for (const body of [
        { revisionId, agentId },
        { revisionId, hostId },
        { revisionId, plan: { services: [] } },
        {},
      ]) {
        const response = await api('post', `/api/v1/stacks/${stackId}/deploy`, body);

        expect(response.status).toBe(400);
      }

      expect(dispatched).not.toContain('stack.deploy');
    }, 120_000);

    it('needs the deploy permission', async () => {
      const { stackId, revisionId } = await saveStack();

      session = await signIn('Operator');

      const response = await deploy(stackId, revisionId);

      expect(response.status).toBe(403);
      expect(dispatched).not.toContain('stack.deploy');
    }, 120_000);

    it('refuses while the host cannot be reached', async () => {
      const { stackId, revisionId } = await saveStack();

      connection.close();
      await new Promise((resolve) => setTimeout(resolve, 250));

      const response = await deploy(stackId, revisionId);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('AGENT_OFFLINE');
      expect(await deploymentRow(stackId)).toBeUndefined();
    }, 120_000);
  });

  describe('a name somebody else holds', () => {
    it('refuses before anything is written down', async () => {
      const { stackId, revisionId } = await saveStack();
      const stack = await stackRow(stackId);

      host.seed(`${stack.name}-web-1`);
      await discovery.sync(agentId);

      const response = await deploy(stackId, revisionId);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('RESOURCE_NAME_CONFLICT');
      expect(dispatched).not.toContain('stack.deploy');
      expect(await deploymentRow(stackId)).toBeUndefined();
      expect(await stackContainers(stackId)).toHaveLength(0);
    }, 120_000);
  });

  describe('a deployment that did not happen', () => {
    it('leaves the host as it was and lets the stack be deployed again', async () => {
      const { stackId, revisionId } = await saveStack();

      host.wontCreate.add('database');

      const response = await deploy(stackId, revisionId);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_DEPLOYMENT_FAILED');

      const stack = await stackRow(stackId);

      expect(stack.currentRevisionId).toBeNull();
      expect(stack.status).toBe('not_deployed');

      const deployment = await deploymentRow(stackId);

      expect(deployment.status).toBe('failed');

      // The resources allocated for an attempt that created nothing are gone,
      // so the names they held are free again.
      expect(await stackContainers(stackId)).toHaveLength(0);

      host.wontCreate.clear();

      const second = await deploy(stackId, revisionId);

      expect(second.status).toBe(200);
      expect((await stackRow(stackId)).currentRevisionId).toBe(revisionId);
    }, 120_000);
  });

  describe('a deployment that half happened', () => {
    it('keeps what started, deploys nothing further, and waits for a person', async () => {
      const { stackId, revisionId } = await saveStack();

      host.wontStart.add('web');

      const response = await deploy(stackId, revisionId);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_DEPLOYMENT_PARTIAL');

      const stack = await stackRow(stackId);

      expect(stack.currentRevisionId).toBeNull();
      expect(stack.status).toBe('needs_attention');

      const deployment = await deploymentRow(stackId);

      expect(deployment.status).toBe('needs_attention');
      // Unresolved, so the attempt is not over and nothing was tidied away.
      expect(deployment.resolvedAt).toBeNull();

      const rows = await stackContainers(stackId);

      expect(rows.filter((row) => row.dockerId !== null)).toHaveLength(2);
      expect(host.containers.size).toBe(2);

      const again = await deploy(stackId, revisionId);

      expect(again.status).toBe(409);
      expect(again.body.code).toBe('STACK_NEEDS_ATTENTION');
    }, 120_000);

    it('refuses to start, stop or restart a container of that stack', async () => {
      const { stackId, revisionId } = await saveStack();

      host.wontStart.add('web');
      await deploy(stackId, revisionId);

      const [row] = await stackContainers(stackId);

      const response = await api('post', `/api/v1/containers/${row.id}/restart`, {});

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_DEPLOYMENT_CONFLICT');
    }, 120_000);
  });

  describe('a container of a deployed stack', () => {
    it('cannot be replaced or removed on its own', async () => {
      const { stackId } = await deployed();
      const [row] = await stackContainers(stackId);

      const replaced = await request(app.getHttpServer())
        .put(`/api/v1/containers/${row.id}`)
        .set('cookie', session.cookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', session.csrf)
        .send({ image: 'nginx:1.28' });

      expect(replaced.status).toBe(409);
      expect(replaced.body.code).toBe('MANAGED_BY_STACK');

      const removed = await request(app.getHttpServer())
        .delete(`/api/v1/containers/${row.id}`)
        .set('cookie', session.cookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', session.csrf)
        .send({});

      expect(removed.status).toBe(409);
      expect(removed.body.code).toBe('MANAGED_BY_STACK');
    }, 120_000);
  });

  describe('an answer that never came back', () => {
    it('says so, repeats nothing, and blocks the stack until it is settled', async () => {
      const { stackId, revisionId } = await saveStack();

      dropOn.add('stack.deploy');

      const response = await deploy(stackId, revisionId);

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('OPERATION_OUTCOME_UNKNOWN');

      const deployment = await deploymentRow(stackId);

      expect(deployment.status).toBe('interrupted');
      expect((await stackRow(stackId)).currentRevisionId).toBeNull();

      await reconnect();

      const attempts = dispatched.filter((capability) => capability === 'stack.deploy').length;

      const again = await deploy(stackId, revisionId);

      expect(again.status).toBe(409);
      expect(again.body.code).toBe('STACK_DEPLOYMENT_CONFLICT');

      // Nothing was sent a second time, by the retry or by anything else.
      expect(dispatched.filter((capability) => capability === 'stack.deploy')).toHaveLength(
        attempts,
      );
    }, 120_000);

    it('settles as a failure when the host turns out to have done nothing', async () => {
      const { stackId, revisionId } = await saveStack();

      dropOn.add('stack.deploy');
      await deploy(stackId, revisionId);
      await reconnect();

      await stackRecovery.recoverHost(hostId);

      expect((await deploymentRow(stackId)).status).toBe('failed');

      const stack = await stackRow(stackId);

      expect(stack.currentRevisionId).toBeNull();
      expect(stack.status).toBe('not_deployed');
    }, 120_000);

    it('settles as a success when the host turns out to have deployed it', async () => {
      const { stackId, revisionId } = await saveStack();

      dropAfter.add('stack.deploy');
      await deploy(stackId, revisionId);
      await reconnect();

      await stackRecovery.recoverHost(hostId);

      expect((await deploymentRow(stackId)).status).toBe('succeeded');

      const stack = await stackRow(stackId);

      expect(stack.currentRevisionId).toBe(revisionId);
      expect(stack.status).toBe('running');
    }, 120_000);

    it('settles nothing while the host cannot be read', async () => {
      const { stackId, revisionId } = await saveStack();

      dropAfter.add('stack.deploy');
      await deploy(stackId, revisionId);

      /*
       * The agent is gone, so the host cannot be read at all. The stack is
       * running on it — this is the case where concluding anything would be
       * concluding it from nothing.
       */
      await stackRecovery.recoverHost(hostId);

      const deployment = await deploymentRow(stackId);

      expect(deployment.status).toBe('interrupted');
      expect((await stackRow(stackId)).currentRevisionId).toBeNull();
    }, 120_000);
  });

  describe('the values a stack was configured with', () => {
    it('reach the agent and nothing else', async () => {
      const { stackId } = await deployed();

      // The plan legitimately carries the secret: a container cannot be created
      // with a value nobody sent.
      expect(JSON.stringify(host.stackPlans)).toContain(CANARY);

      const rows = await Promise.all([
        db.client.select().from(auditEntries),
        db.client.select().from(events),
        db.client.select().from(actions),
        db.client.select().from(stackDeployments),
        stackContainers(stackId),
      ]);

      expect(JSON.stringify(rows)).not.toContain(CANARY);
    }, 120_000);

    it('is not in what the deployment answers with', async () => {
      const { response } = await deployed();

      expect(JSON.stringify(response.body)).not.toContain(CANARY);
    }, 120_000);
  });

  describe('the record of an attempt', () => {
    it('names the stack and the revision and nothing from the file', async () => {
      const { stackId } = await deployed();

      const entries = await db.client
        .select()
        .from(auditEntries)
        .where(sql`${auditEntries.action} like 'stack.deploy%'`);

      expect(entries.map((entry) => entry.action)).toEqual([
        'stack.deploy.requested',
        'stack.deploy.succeeded',
      ]);

      for (const entry of entries) {
        expect(entry.targetId).toBe(stackId);
        expect(JSON.stringify(entry)).not.toContain('postgres:17');
      }
    }, 120_000);
  });
});
