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
  actions,
  auditEntries,
  containers,
  stackDeployments,
  stackOperations,
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

/** In a stack secret. A lifecycle operation must never go anywhere near it. */
const CANARY = 'canary-stack-lifecycle-1c0ffee';

/**
 * Starting, stopping and restarting a deployed stack.
 *
 * The same arrangement the deployment tests use — a real mTLS connection in
 * front of a small model of a Docker host — because the same rule applies: what
 * the server concludes comes from reading the host, not from the agent's reply.
 *
 * Three things get the most scrutiny. Nothing here deploys: the revision the
 * stack is running does not change, and neither does the newest one saved.
 * Nothing here needs a Compose file: no compiler runs and no secret is
 * decrypted, which is what makes stopping a stack possible during the incident
 * where its configuration has stopped compiling. And a restart that nobody can
 * demonstrate happened is never recorded as one — the case the whole
 * fingerprint exists for.
 */
describe('operating a deployed stack', () => {
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

  describe('stopping', () => {
    it('stops every service and says the stack is stopped', async () => {
      const { stackId, revisionId } = await deployed();

      const response = await api('post', `/api/v1/stacks/${stackId}/stop`);

      expect(response.status).toBe(200);
      expect(response.body.operation).toBe('stop');

      for (const container of onHost(stackId).values()) {
        expect(container.state).toBe('exited');
      }

      const stack = await stackRow(stackId);

      expect(stack.status).toBe('stopped');
      // Stopped is not undeployed. The revision it is deployed with is the one
      // it was deployed with, and starting it again deploys nothing.
      expect(stack.currentRevisionId).toBe(revisionId);
      expect(stack.latestRevisionId).toBe(revisionId);
    }, 120_000);

    it('stops what depends on something before the thing it depends on', async () => {
      const { stackId } = await deployed();

      await api('post', `/api/v1/stacks/${stackId}/stop`);

      const [operation] = host.stackOperations;

      expect(operation.operation).toBe('stop');
      // The order is the agent's to carry out; what the server owes it is the
      // dependency it needs to work that out.
      expect(operation.plan.services.find((service) => service.serviceName === 'web')?.dependsOn) //
        .toEqual(['database']);
    }, 120_000);

    /*
     * The reason lifecycle is a separate path at all.
     *
     * A stack whose Compose source no longer compiles — because the compiler is
     * gone, because a variable it needs was removed, because the encryption key
     * is unavailable — must still be one an operator can stop. Nothing here
     * reads the source, so nothing here can be stopped by it.
     */
    it('needs no compiler and no Compose source', async () => {
      const { stackId } = await deployed();

      const compiler = process.env.DOCKPLANE_COMPOSE_COMPILER;
      process.env.DOCKPLANE_COMPOSE_COMPILER = join(workspace, 'no-such-compiler');

      try {
        const response = await api('post', `/api/v1/stacks/${stackId}/stop`);

        expect(response.status).toBe(200);
      } finally {
        process.env.DOCKPLANE_COMPOSE_COMPILER = compiler;
      }
    }, 120_000);

    /* No environment is resolved, so nothing a secret could ride out on exists. */
    it('sends the host nothing but identities', async () => {
      const { stackId } = await deployed();

      await api('post', `/api/v1/stacks/${stackId}/stop`);

      const [operation] = host.stackOperations;
      const sent = JSON.stringify(operation.plan);

      expect(sent).not.toContain(CANARY);
      expect(sent).not.toContain('POSTGRES_PASSWORD');
      expect(sent).not.toContain('image');
    }, 120_000);
  });

  describe('starting', () => {
    it('starts a stopped stack without changing what it is deployed with', async () => {
      const { stackId, revisionId } = await deployed();

      await api('post', `/api/v1/stacks/${stackId}/stop`);

      const before = [...onHost(stackId).values()].map((container) => container.dockerId).sort();

      const response = await api('post', `/api/v1/stacks/${stackId}/start`);

      expect(response.status).toBe(200);

      for (const container of onHost(stackId).values()) {
        expect(container.state).toBe('running');
      }

      // The same containers: starting one is not building one.
      expect([...onHost(stackId).values()].map((container) => container.dockerId).sort()) //
        .toEqual(before);

      const stack = await stackRow(stackId);

      expect(stack.status).toBe('running');
      expect(stack.currentRevisionId).toBe(revisionId);
    }, 120_000);

    /*
     * Saved is still not deployed, which a lifecycle operation must not blur.
     *
     * A stack running revision one with revision two saved is started as
     * revision one. Anything else would deploy a change nobody asked to deploy,
     * from a button that says start.
     */
    it('does not deploy a newer revision somebody saved', async () => {
      const { stackId, revisionId } = await deployed();

      const saved = await api('post', `/api/v1/stacks/${stackId}/revisions`, {
        baseRevisionId: revisionId,
        compose: COMPOSE.replace('nginx:1.27', 'nginx:1.28'),
        environment: [{ operation: 'unchanged', key: 'DB_PASSWORD' }],
      });

      expect(saved.status).toBe(201);

      await api('post', `/api/v1/stacks/${stackId}/stop`);
      await api('post', `/api/v1/stacks/${stackId}/start`);

      const stack = await stackRow(stackId);

      expect(stack.currentRevisionId).toBe(revisionId);
      expect(stack.latestRevisionId).toBe(saved.body.revisionId);

      for (const container of onHost(stackId).values()) {
        expect(container.image).not.toBe('nginx:1.28');
      }
    }, 120_000);
  });

  describe('restarting', () => {
    it('keeps every container and starts it again', async () => {
      const { stackId, revisionId } = await deployed();

      const before = new Map(
        [...onHost(stackId).entries()].map(([service, container]) => [
          service,
          { dockerId: container.dockerId, startedAt: container.startedAt },
        ]),
      );

      const response = await api('post', `/api/v1/stacks/${stackId}/restart`);

      expect(response.status).toBe(200);

      for (const [service, container] of onHost(stackId)) {
        expect(container.state).toBe('running');
        // Nothing is recreated, so an operator's link to a container still
        // points at the same container afterwards.
        expect(container.dockerId).toBe(before.get(service)!.dockerId);
        expect(Date.parse(container.startedAt!)).toBeGreaterThan(
          Date.parse(before.get(service)!.startedAt!),
        );
      }

      const stack = await stackRow(stackId);

      expect(stack.status).toBe('running');
      expect(stack.currentRevisionId).toBe(revisionId);
    }, 120_000);

    /* The resources an operator navigates by are the same ones afterwards. */
    it('keeps the container resources it restarted', async () => {
      const { stackId } = await deployed();

      const before = (await stackContainers(stackId)).map((row) => row.id).sort();

      await api('post', `/api/v1/stacks/${stackId}/restart`);

      expect((await stackContainers(stackId)).map((row) => row.id).sort()).toEqual(before);
    }, 120_000);
  });

  describe('what may not be operated', () => {
    it('refuses a stack that has never been deployed', async () => {
      const { stackId } = await saveStack();

      const response = await api('post', `/api/v1/stacks/${stackId}/start`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_NOT_DEPLOYED');
      expect(host.stackOperations).toHaveLength(0);
    }, 120_000);

    /*
     * A stack that needs attention is a host somebody is about to be asked to
     * make sense of. Stopping half of it first changes the evidence they would
     * decide from.
     */
    it('refuses a stack that needs attention', async () => {
      const { stackId } = await deployed();

      await db.client
        .update(stacks)
        .set({ status: 'needs_attention' })
        .where(eq(stacks.id, stackId));

      const response = await api('post', `/api/v1/stacks/${stackId}/restart`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_NEEDS_ATTENTION');
      expect(host.stackOperations).toHaveLength(0);
    }, 120_000);

    it('refuses a service that has no container on the host', async () => {
      const { stackId } = await deployed();

      const [container] = await stackContainers(stackId);

      await db.client
        .update(containers)
        .set({ dockerId: null })
        .where(eq(containers.id, container.id));

      const response = await api('post', `/api/v1/stacks/${stackId}/stop`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_SERVICE_MISSING');
      expect(host.stackOperations).toHaveLength(0);
    }, 120_000);

    /* Operator carries container restart and deliberately not stack deployment. */
    it('refuses somebody without the permission', async () => {
      const { stackId } = await deployed();

      session = await signIn('Operator');

      const response = await api('post', `/api/v1/stacks/${stackId}/stop`);

      expect(response.status).toBe(403);
      expect(host.stackOperations).toHaveLength(0);
    }, 120_000);
  });

  describe('one thing at a time', () => {
    /*
     * A deployment and an operation are two different records and one rule:
     * whatever a stack's state is about to be, only one thing may be deciding
     * it.
     */
    it('refuses an operation while a deployment has not resolved', async () => {
      const { stackId, revisionId } = await deployed();

      await db.client.insert(stackDeployments).values({
        stackId,
        revisionId,
        hostId,
        kind: 'redeploy',
        status: 'interrupted',
      });

      const response = await api('post', `/api/v1/stacks/${stackId}/stop`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_DEPLOYMENT_CONFLICT');
      expect(host.stackOperations).toHaveLength(0);
    }, 120_000);

    it('refuses a deployment while an operation has not resolved', async () => {
      const { stackId, revisionId } = await deployed();

      const saved = await api('post', `/api/v1/stacks/${stackId}/revisions`, {
        baseRevisionId: revisionId,
        compose: COMPOSE.replace('nginx:1.27', 'nginx:1.28'),
        environment: [{ operation: 'unchanged', key: 'DB_PASSWORD' }],
      });

      await db.client.insert(stackOperations).values({
        stackId,
        revisionId,
        hostId,
        type: 'stop',
        status: 'interrupted',
      });

      const response = await api('post', `/api/v1/stacks/${stackId}/deploy`, {
        revisionId: saved.body.revisionId,
      });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_OPERATION_CONFLICT');
    }, 120_000);

    it('refuses a second operation while one has not resolved', async () => {
      const { stackId, revisionId } = await deployed();

      await db.client.insert(stackOperations).values({
        stackId,
        revisionId,
        hostId,
        type: 'restart',
        status: 'interrupted',
      });

      const response = await api('post', `/api/v1/stacks/${stackId}/start`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_OPERATION_CONFLICT');
    }, 120_000);

    /* The record in the database is what survives the lock being forgotten. */
    it('refuses a container operation while a stack operation has not resolved', async () => {
      const { stackId, revisionId } = await deployed();

      await db.client.insert(stackOperations).values({
        stackId,
        revisionId,
        hostId,
        type: 'stop',
        status: 'interrupted',
      });

      const [container] = await stackContainers(stackId);
      const response = await api('post', `/api/v1/containers/${container.id}/restart`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_OPERATION_CONFLICT');
    }, 120_000);
  });

  describe('an answer that never came back', () => {
    it('does not call an unknown outcome a failure, and repeats nothing', async () => {
      const { stackId } = await deployed();

      dropAfter = new Set(['stack.stop']);

      const response = await api('post', `/api/v1/stacks/${stackId}/stop`);

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('OPERATION_OUTCOME_UNKNOWN');

      const [operation] = await operationRows(stackId);

      expect(operation.status).toBe('interrupted');
      expect(dispatched.filter((capability) => capability === 'stack.stop')).toHaveLength(1);
    }, 120_000);

    it('settles a stop that reached the host from the host itself', async () => {
      const { stackId } = await deployed();

      dropAfter = new Set(['stack.stop']);

      await api('post', `/api/v1/stacks/${stackId}/stop`);
      await reconnect();

      expect(await stackRecovery.recoverHost(hostId)).toBe(1);

      const [operation] = await operationRows(stackId);

      expect(operation.status).toBe('succeeded');
      expect((await stackRow(stackId)).status).toBe('stopped');
      // Still once. Recovery establishes what happened; it never repeats it.
      expect(dispatched.filter((capability) => capability === 'stack.stop')).toHaveLength(1);
    }, 120_000);

    it('settles a stop that never reached the host as one that did not happen', async () => {
      const { stackId } = await deployed();

      dropOn = new Set(['stack.stop']);

      await api('post', `/api/v1/stacks/${stackId}/stop`);
      await reconnect();

      expect(await stackRecovery.recoverHost(hostId)).toBe(1);

      const [operation] = await operationRows(stackId);

      expect(operation.status).toBe('failed');
      expect(operation.failureCode).toBe('STACK_STOP_FAILED');
      // The stack is what it was, which is a state it can be operated from.
      expect((await stackRow(stackId)).status).toBe('running');
    }, 120_000);

    /*
     * The case a final state cannot answer.
     *
     * The stack was running before the restart and is running after it. Nothing
     * about the containers changed except when Docker last started them, which
     * is why the operation recorded that before it was dispatched.
     */
    it('recognises a restart that happened from when the containers started', async () => {
      const { stackId } = await deployed();

      dropAfter = new Set(['stack.restart']);

      await api('post', `/api/v1/stacks/${stackId}/restart`);
      await reconnect();

      expect(await stackRecovery.recoverHost(hostId)).toBe(1);

      const [operation] = await operationRows(stackId);

      expect(operation.status).toBe('succeeded');
      expect((await stackRow(stackId)).status).toBe('running');
    }, 120_000);

    it('recognises a restart that did not happen, though nothing else changed', async () => {
      const { stackId } = await deployed();

      dropOn = new Set(['stack.restart']);

      await api('post', `/api/v1/stacks/${stackId}/restart`);
      await reconnect();

      expect(await stackRecovery.recoverHost(hostId)).toBe(1);

      const [operation] = await operationRows(stackId);

      expect(operation.status).toBe('failed');
      expect(operation.failureCode).toBe('STACK_RESTART_FAILED');
      expect((await stackRow(stackId)).status).toBe('running');
    }, 120_000);

    /* An operation nobody has settled keeps the stack blocked across a restart. */
    it('keeps the stack blocked until it is settled', async () => {
      const { stackId } = await deployed();

      dropAfter = new Set(['stack.stop']);

      await api('post', `/api/v1/stacks/${stackId}/stop`);
      await reconnect();

      const blocked = await api('post', `/api/v1/stacks/${stackId}/start`);

      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('STACK_OPERATION_CONFLICT');
    }, 120_000);
  });

  describe('a stack left half moved', () => {
    /*
     * Nothing is started again to tidy this up. The service that stopped may be
     * the one holding a lock something else is waiting on, and a host that has
     * just refused an instruction is not one to send more of them to.
     */
    it('says the stack needs attention rather than that it stopped', async () => {
      const { stackId, revisionId } = await deployed();

      host.wontStop.add('database');

      const response = await api('post', `/api/v1/stacks/${stackId}/stop`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_LIFECYCLE_PARTIAL');

      const stack = await stackRow(stackId);

      expect(stack.status).toBe('needs_attention');
      // What it is deployed with has not changed: nothing was deployed.
      expect(stack.currentRevisionId).toBe(revisionId);

      const [operation] = await operationRows(stackId);

      expect(operation.status).toBe('needs_attention');
    }, 120_000);

    it('blocks everything until somebody applies a revision', async () => {
      const { stackId, revisionId } = await deployed();

      host.wontStop.add('database');
      await api('post', `/api/v1/stacks/${stackId}/stop`);

      const blocked = await api('post', `/api/v1/stacks/${stackId}/start`);

      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('STACK_NEEDS_ATTENTION');

      // The way out, and the only one: applying a revision recreates every
      // service, which converges the whole stack on one state.
      host.wontStop.clear();

      const repaired = await api('post', `/api/v1/stacks/${stackId}/deploy`, { revisionId });

      expect(repaired.status).toBe(200);
      expect((await stackRow(stackId)).status).toBe('running');
    }, 120_000);
  });

  describe('what is written down', () => {
    it('records the operation, the action and the audit trail', async () => {
      const { stackId } = await deployed();

      await api('post', `/api/v1/stacks/${stackId}/restart`);

      const [operation] = await operationRows(stackId);

      expect(operation.type).toBe('restart');
      expect(operation.status).toBe('succeeded');
      expect(operation.resolvedAt).not.toBeNull();

      const [action] = await db.client
        .select()
        .from(actions)
        .where(eq(actions.id, operation.actionId!));

      expect(action.capability).toBe('stack.restart');
      expect(action.status).toBe('succeeded');

      const recorded = await db.client.select().from(auditEntries);
      const kinds = recorded.map((entry) => entry.action);

      expect(kinds).toContain('stack.restart.requested');
      expect(kinds).toContain('stack.restarted');
      expect(JSON.stringify(recorded)).not.toContain(CANARY);
    }, 120_000);

    /* A restart is not a deployment, and the history must not say it was. */
    it('writes no deployment for an operation', async () => {
      const { stackId } = await deployed();

      const before = await db.client
        .select()
        .from(stackDeployments)
        .where(eq(stackDeployments.stackId, stackId));

      await api('post', `/api/v1/stacks/${stackId}/restart`);

      const after = await db.client
        .select()
        .from(stackDeployments)
        .where(eq(stackDeployments.stackId, stackId));

      expect(after).toHaveLength(before.length);
    }, 120_000);

    /* Identifiers and a time. Nothing that could carry a value out. */
    it('records a fingerprint that carries no configuration', async () => {
      const { stackId } = await deployed();

      await api('post', `/api/v1/stacks/${stackId}/restart`);

      const [operation] = await operationRows(stackId);
      const fingerprint = JSON.stringify(operation.fingerprint);

      expect(operation.fingerprint?.services).toHaveLength(2);
      expect(fingerprint).not.toContain(CANARY);
      expect(fingerprint).not.toContain('POSTGRES_PASSWORD');
      expect(fingerprint).not.toContain('image');
    }, 120_000);
  });

  describe('what the interface is told', () => {
    it('reports the deployed revision and the runtime state separately', async () => {
      const { stackId, revisionId } = await deployed();

      await api('post', `/api/v1/stacks/${stackId}/stop`);

      const response = await api('get', `/api/v1/stacks/${stackId}`);

      expect(response.status).toBe(200);
      expect(response.body.stack.status).toBe('stopped');
      // Deployed, not running: the difference the word has to carry once a
      // stack can be stopped without being undeployed.
      expect(response.body.stack.deployedRevision.id).toBe(revisionId);
      expect(response.body.stack.reconciling).toBe(false);
    }, 120_000);

    it('says a stack with an unresolved operation is reconciling', async () => {
      const { stackId } = await deployed();

      dropAfter = new Set(['stack.stop']);
      await api('post', `/api/v1/stacks/${stackId}/stop`);
      await reconnect();

      const response = await api('get', `/api/v1/stacks/${stackId}`);

      expect(response.body.stack.reconciling).toBe(true);
    }, 120_000);
  });
});
