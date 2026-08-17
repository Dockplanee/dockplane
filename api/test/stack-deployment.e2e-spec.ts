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
  agents,
  actions,
  auditEntries,
  containers,
  events,
  stackDeployments,
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

  /** Revision two of the same stack: `database` is gone and `worker` is new. */
  const WORKER_COMPOSE = [
    'services:',
    '  web:',
    '    image: nginx:1.27',
    '  worker:',
    '    image: busybox:1.36',
    '    environment:',
    '      QUEUE_PASSWORD: ${DB_PASSWORD}',
    'volumes:',
    '  data: {}',
  ].join('\n');

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

  /** Saves another revision of a stack, on top of the one given. */
  const saveRevision = async (stackId: string, baseRevisionId: string, compose: string) => {
    const response = await api('post', `/api/v1/stacks/${stackId}/revisions`, {
      baseRevisionId,
      compose,
      environment: [{ operation: 'unchanged', key: 'DB_PASSWORD' }],
    });

    expect(response.status).toBe(201);

    return response.body.revisionId as string;
  };

  const stackRow = async (stackId: string) => {
    const [row] = await db.client.select().from(stacks).where(eq(stacks.id, stackId));

    return row;
  };

  /** The newest attempt on a stack. */
  const deploymentRow = async (stackId: string) => {
    const rows = await db.client
      .select()
      .from(stackDeployments)
      .where(eq(stackDeployments.stackId, stackId))
      .orderBy(stackDeployments.startedAt);

    return rows[rows.length - 1];
  };

  const deploymentRows = async (stackId: string) =>
    db.client
      .select()
      .from(stackDeployments)
      .where(eq(stackDeployments.stackId, stackId))
      .orderBy(stackDeployments.startedAt);

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

    /*
     * Applying the revision that is already running would recreate every
     * container to arrive back where it started.
     */
    it('refuses to apply the revision it is already running', async () => {
      const { stackId, revisionId } = await deployed();
      const attempts = dispatched.filter((capability) => capability === 'stack.deploy').length;
      const again = await deploy(stackId, revisionId);

      expect(again.status).toBe(409);
      expect(again.body.code).toBe('STACK_REVISION_ALREADY_DEPLOYED');
      expect(dispatched.filter((capability) => capability === 'stack.deploy')).toHaveLength(
        attempts,
      );
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
      expect(response.body.code).toBe('STACK_APPLY_FAILED');

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

  describe('an attempt that leaves the host half applied', () => {
    it('says so, changes nothing about the stack, and blocks its containers', async () => {
      const { stackId, revisionId } = await saveStack();

      // The target does not come up and the host cannot be put back.
      host.wontStart.add('web');
      host.leaveHalfApplied = true;

      const response = await deploy(stackId, revisionId);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_DEPLOYMENT_PARTIAL');

      const stack = await stackRow(stackId);

      expect(stack.currentRevisionId).toBeNull();
      expect(stack.status).toBe('needs_attention');
      expect((await deploymentRow(stackId)).status).toBe('needs_attention');

      // Nothing was removed: what came up is still up.
      expect(host.containers.size).toBeGreaterThan(0);
    }, 120_000);

    it('refuses to start, stop or restart a container of that stack', async () => {
      const { stackId, revisionId } = await saveStack();

      host.wontStart.add('web');
      host.leaveHalfApplied = true;
      await deploy(stackId, revisionId);

      const [row] = (await stackContainers(stackId)).filter((found) => found.dockerId !== null);

      const response = await api('post', `/api/v1/containers/${row.id}/restart`, {});

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_NEEDS_ATTENTION');
    }, 120_000);

    /*
     * The way out. A stack that needs attention is converged by somebody
     * choosing a revision and applying it, which is an ordinary new attempt
     * rather than a retry of the one that failed.
     */
    it('is repaired by applying a revision to it deliberately', async () => {
      const { stackId, revisionId } = await saveStack();

      host.wontStart.add('web');
      host.leaveHalfApplied = true;
      await deploy(stackId, revisionId);

      host.wontStart.clear();
      host.leaveHalfApplied = false;

      const repair = await deploy(stackId, revisionId);

      expect(repair.status).toBe(200);
      expect(repair.body.kind).toBe('repair');

      const stack = await stackRow(stackId);

      expect(stack.status).toBe('running');
      expect(stack.currentRevisionId).toBe(revisionId);

      // A second attempt, not a retry of the first.
      const attempts = await deploymentRows(stackId);

      expect(attempts).toHaveLength(2);
      expect(attempts[0].status).toBe('needs_attention');
      expect(attempts[1].status).toBe('succeeded');
      expect(attempts[1].kind).toBe('repair');
    }, 120_000);

    /*
     * Two containers claiming one service. Choosing between them is choosing
     * which of somebody's containers to destroy, so nothing is applied at all.
     */
    it('is not repaired while two containers claim one service', async () => {
      const { stackId, revisionId } = await deployed();
      const stack = await stackRow(stackId);

      // A leftover from an earlier revision, still carrying a service that
      // already has a container. Only the host can be in this state: the
      // database allows one container per service of a stack.
      host.seed(`${stack.name}-web-old`, {
        'io.dockplane.managed': 'true',
        'io.dockplane.stack-id': stackId,
        'io.dockplane.stack-service': 'web',
        'io.dockplane.stack-revision-id': revisionId,
        'io.dockplane.container-id': 'a-resource-nobody-allocated',
      });

      const second = await saveRevision(
        stackId,
        revisionId,
        COMPOSE.replace('nginx:1.27', 'nginx:1.28'),
      );

      const response = await deploy(stackId, second);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_REPAIR_AMBIGUOUS');

      // Nothing was applied: the stack is still what it was.
      expect((await stackRow(stackId)).currentRevisionId).toBe(revisionId);
    }, 120_000);
  });

  describe('moving a running stack to another revision', () => {
    it('applies it, keeps the service resources and records the new revision', async () => {
      const { stackId, revisionId } = await deployed();
      const before = await stackContainers(stackId);

      const second = await saveRevision(
        stackId,
        revisionId,
        COMPOSE.replace('nginx:1.27', 'nginx:1.28'),
      );

      const response = await deploy(stackId, second);

      expect(response.status).toBe(200);
      expect(response.body.kind).toBe('redeploy');

      const stack = await stackRow(stackId);

      expect(stack.currentRevisionId).toBe(second);
      expect(stack.latestRevisionId).toBe(second);
      expect(stack.status).toBe('running');

      const after = await stackContainers(stackId);

      // The same Dockplane resources, different Docker containers.
      expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());

      for (const row of after) {
        const was = before.find((found) => found.id === row.id)!;

        expect(row.dockerId).not.toBe(was.dockerId);
        expect(row.stackRevisionId).toBe(second);
      }
    }, 120_000);

    /*
     * Saving is not deploying. A stack goes on running what it was running
     * until somebody says otherwise.
     */
    it('leaves the host alone when a revision is only saved', async () => {
      const { stackId, revisionId } = await deployed();
      const attempts = dispatched.filter((capability) => capability === 'stack.deploy').length;

      const second = await saveRevision(
        stackId,
        revisionId,
        COMPOSE.replace('nginx:1.27', 'nginx:1.28'),
      );

      const stack = await stackRow(stackId);

      expect(stack.latestRevisionId).toBe(second);
      expect(stack.currentRevisionId).toBe(revisionId);
      expect(dispatched.filter((capability) => capability === 'stack.deploy')).toHaveLength(
        attempts,
      );
    }, 120_000);

    it('adds and removes services, and gives a new service a new resource', async () => {
      const { stackId, revisionId } = await deployed();
      const before = await stackContainers(stackId);
      const web = before.find((row) => row.stackService === 'web')!;

      const second = await saveRevision(stackId, revisionId, WORKER_COMPOSE);
      const response = await deploy(stackId, second);

      expect(response.status).toBe(200);

      const after = await stackContainers(stackId);

      expect(after.map((row) => row.stackService).sort()).toEqual(['web', 'worker']);

      // The service that stayed kept its resource; the new one is new.
      expect(after.find((row) => row.stackService === 'web')!.id).toBe(web.id);
      expect(after.find((row) => row.stackService === 'worker')!.id).not.toBe(web.id);

      // The volume the removed service used is still there.
      expect([...host.volumes].some((name) => name.endsWith('_data'))).toBe(true);
    }, 120_000);
  });

  describe('going back to an older revision', () => {
    it('applies it without changing what was last saved', async () => {
      const { stackId, revisionId } = await deployed();

      const second = await saveRevision(
        stackId,
        revisionId,
        COMPOSE.replace('nginx:1.27', 'nginx:1.28'),
      );

      expect((await deploy(stackId, second)).status).toBe(200);

      const response = await deploy(stackId, revisionId);

      expect(response.status).toBe(200);
      expect(response.body.kind).toBe('rollback');

      const stack = await stackRow(stackId);

      // What is running went back; what was saved did not.
      expect(stack.currentRevisionId).toBe(revisionId);
      expect(stack.latestRevisionId).toBe(second);

      const revisions = await db.client
        .select()
        .from(stackRevisions)
        .where(eq(stackRevisions.stackId, stackId));

      // No revision was invented to describe the rollback.
      expect(revisions).toHaveLength(2);

      for (const row of await stackContainers(stackId)) {
        expect(row.stackRevisionId).toBe(revisionId);
      }
    }, 120_000);

    it('is recorded as a rollback rather than as an ordinary deployment', async () => {
      const { stackId, revisionId } = await deployed();

      const second = await saveRevision(
        stackId,
        revisionId,
        COMPOSE.replace('nginx:1.27', 'nginx:1.28'),
      );

      await deploy(stackId, second);
      await deploy(stackId, revisionId);

      const entries = await db.client
        .select()
        .from(auditEntries)
        .where(
          sql`${auditEntries.action} like 'stack.rollback%' or ${auditEntries.action} = 'stack.rolled_back'`,
        );

      expect(entries.map((entry) => entry.action).sort()).toEqual([
        'stack.rollback.requested',
        'stack.rolled_back',
      ]);
    }, 120_000);
  });

  describe('a revision that does not come up', () => {
    it('leaves the stack exactly as it was', async () => {
      const { stackId, revisionId } = await deployed();
      const before = await stackContainers(stackId);

      const second = await saveRevision(
        stackId,
        revisionId,
        COMPOSE.replace('nginx:1.27', 'nginx:1.28'),
      );

      host.wontStart.add('web');

      const response = await deploy(stackId, second);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STACK_APPLY_FAILED');

      const stack = await stackRow(stackId);

      expect(stack.currentRevisionId).toBe(revisionId);
      expect(stack.status).toBe('running');

      const attempt = await deploymentRow(stackId);

      expect(attempt.status).toBe('rolled_back');
      expect(attempt.fromRevisionId).toBe(revisionId);
      expect(attempt.revisionId).toBe(second);

      // The same containers as before, still running the revision they were.
      const after = await stackContainers(stackId);

      expect(after.map((row) => row.dockerId).sort()).toEqual(
        before.map((row) => row.dockerId).sort(),
      );

      for (const row of after) {
        expect(row.stackRevisionId).toBe(revisionId);
      }
    }, 120_000);

    it('does not call it a rollback in the record', async () => {
      const { stackId, revisionId } = await deployed();

      const second = await saveRevision(
        stackId,
        revisionId,
        COMPOSE.replace('nginx:1.27', 'nginx:1.28'),
      );

      host.wontStart.add('web');
      await deploy(stackId, second);

      const entries = await db.client
        .select()
        .from(auditEntries)
        .where(sql`${auditEntries.action} like 'stack.%'`);

      const actions = entries.map((entry) => entry.action);

      expect(actions).toContain('stack.apply.rolled_back');
      expect(actions).not.toContain('stack.rolled_back');
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

  describe('an answer that never came back during a transition', () => {
    it('settles on the new revision when the host turns out to have applied it', async () => {
      const { stackId, revisionId } = await deployed();

      const second = await saveRevision(
        stackId,
        revisionId,
        COMPOSE.replace('nginx:1.27', 'nginx:1.28'),
      );

      dropAfter.add('stack.deploy');

      const response = await deploy(stackId, second);

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('OPERATION_OUTCOME_UNKNOWN');
      expect((await stackRow(stackId)).currentRevisionId).toBe(revisionId);

      await reconnect();
      await stackRecovery.recoverHost(hostId);

      const stack = await stackRow(stackId);

      expect(stack.currentRevisionId).toBe(second);
      expect(stack.status).toBe('running');
      expect((await deploymentRow(stackId)).status).toBe('succeeded');
    }, 120_000);

    it('leaves the stack as it was when the host turns out not to have applied it', async () => {
      const { stackId, revisionId } = await deployed();

      const second = await saveRevision(
        stackId,
        revisionId,
        COMPOSE.replace('nginx:1.27', 'nginx:1.28'),
      );

      // The request never reaches the host, so nothing about the stack changed.
      dropOn.add('stack.deploy');
      await deploy(stackId, second);

      await reconnect();
      await stackRecovery.recoverHost(hostId);

      const stack = await stackRow(stackId);

      expect(stack.currentRevisionId).toBe(revisionId);
      expect(stack.status).toBe('running');
      expect((await deploymentRow(stackId)).status).toBe('rolled_back');
    }, 120_000);

    it('needs attention when the host turns out to hold some of each', async () => {
      const { stackId, revisionId } = await deployed();

      const second = await saveRevision(
        stackId,
        revisionId,
        COMPOSE.replace('nginx:1.27', 'nginx:1.28'),
      );

      host.wontStart.add('web');
      host.leaveHalfApplied = true;
      dropAfter.add('stack.deploy');

      await deploy(stackId, second);
      await reconnect();
      await stackRecovery.recoverHost(hostId);

      const stack = await stackRow(stackId);

      expect(stack.status).toBe('needs_attention');
      // What the stack is has not changed: nothing was confirmed.
      expect(stack.currentRevisionId).toBe(revisionId);
      expect((await deploymentRow(stackId)).status).toBe('needs_attention');
    }, 120_000);
  });

  describe('a revision that differs only in a secret', () => {
    /*
     * Nothing observable distinguishes the two revisions except the label the
     * agent stamps, which is the reason every service is recreated rather than
     * only the ones whose configuration changed.
     */
    it('is applied, and is recognised afterwards by its label alone', async () => {
      const { stackId, revisionId } = await deployed();

      const response = await api('post', `/api/v1/stacks/${stackId}/revisions`, {
        baseRevisionId: revisionId,
        compose: COMPOSE,
        environment: [{ operation: 'set-secret', key: 'DB_PASSWORD', value: `${CANARY}-two` }],
      });

      expect(response.status).toBe(201);

      const second = response.body.revisionId as string;

      expect((await deploy(stackId, second)).status).toBe(200);

      const stack = await stackRow(stackId);

      expect(stack.currentRevisionId).toBe(second);

      for (const row of await stackContainers(stackId)) {
        expect(row.stackRevisionId).toBe(second);
      }

      const rows = await Promise.all([
        db.client.select().from(auditEntries),
        db.client.select().from(events),
        db.client.select().from(actions),
        db.client.select().from(stackDeployments),
        stackContainers(stackId),
      ]);

      expect(JSON.stringify(rows)).not.toContain(CANARY);
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
  /*
   * An agent from before 0.3.0-rc.2, which forwarded none of the labels that
   * say which stack a container belongs to.
   *
   * The server cannot tell such an agent's silence from a host with nothing on
   * it, so it must not start something whose result it will not be able to
   * read. The refusal happens before the host is asked for anything: an agent
   * that cannot be understood afterwards must not be given work first.
   */
  describe('a host whose agent does not report stack attribution', () => {
    const ageTheAgent = async (version: string | null) => {
      await db.client.update(agents).set({ version }).where(eq(agents.id, agentId));
    };

    it('is refused, and the host is left alone', async () => {
      const { stackId, revisionId } = await saveStack();

      await ageTheAgent('0.2.0');
      host.received.length = 0;

      const response = await api('post', `/api/v1/stacks/${stackId}/deploy`, { revisionId });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('AGENT_UPGRADE_REQUIRED');
      expect(host.received).not.toContain('stack.deploy');
      expect(host.containers.size).toBe(0);
    }, 120_000);

    /*
     * The protocol is not what is wrong, and saying so would send an operator
     * to the wrong page. An older agent goes on serving everything else.
     */
    it('does not blame the protocol', async () => {
      const { stackId, revisionId } = await saveStack();

      await ageTheAgent('0.2.0');

      const response = await api('post', `/api/v1/stacks/${stackId}/deploy`, { revisionId });

      expect(response.body.code).not.toBe('AGENT_PROTOCOL_UNSUPPORTED');
      expect(String(response.body.message)).not.toContain('protocol');
    }, 120_000);

    it('deploys once the agent has been upgraded', async () => {
      const { stackId, revisionId } = await saveStack();

      await ageTheAgent('0.2.0');
      expect((await api('post', `/api/v1/stacks/${stackId}/deploy`, { revisionId })).status).toBe(
        409,
      );

      await ageTheAgent('0.3.0-rc.2');

      const response = await api('post', `/api/v1/stacks/${stackId}/deploy`, { revisionId });

      expect(response.status).toBe(200);

      const [stack] = await db.client.select().from(stacks).where(eq(stacks.id, stackId));

      expect(stack.currentRevisionId).toBe(revisionId);
    }, 120_000);
  });

  /*
   * What an installation carries out of the defect: containers running on the
   * host, correctly labelled, and a control server holding them with no stack.
   * Upgrading the agent is the whole of the repair — the next listing carries
   * the labels, and discovery attributes them where nothing else has to.
   */
  describe('a deployment whose attribution was lost before the agent was upgraded', () => {
    it('is repaired by the next listing, without touching the database by hand', async () => {
      const { stackId, revisionId } = await deployed();

      await db.client
        .update(containers)
        .set({ stackId: null, stackService: null, stackRevisionId: null })
        .where(eq(containers.stackId, stackId));

      const before = await db.client
        .select()
        .from(containers)
        .where(eq(containers.stackId, stackId));

      expect(before).toHaveLength(0);

      await discovery.sync(agentId);

      const after = await db.client.select().from(containers).where(eq(containers.stackId, stackId));

      expect(after.length).toBeGreaterThan(0);
      expect(after.every((row) => row.stackRevisionId === revisionId)).toBe(true);
      expect(after.map((row) => row.stackService).sort()).toEqual(['database', 'web']);
    }, 120_000);

    /*
     * A container labelled for a stack the server has never heard of. It is
     * what a stack deleted during the defect leaves behind, and the answer is
     * to carry on: the container stays visible as what it is, and nothing
     * invents a stack to hang it on.
     */
    it('leaves a container labelled for a stack that no longer exists alone', async () => {
      const stranger = '11111111-2222-3333-4444-555555555555';

      host.seed('orphan-web-1', {
        'io.dockplane.managed': 'true',
        'io.dockplane.stack-id': stranger,
        'io.dockplane.stack-service': 'web',
        'io.dockplane.stack-revision-id': '66666666-7777-8888-9999-000000000000',
      });

      const sync = await discovery.sync(agentId);

      expect(sync).toBeDefined();

      const [row] = await db.client
        .select()
        .from(containers)
        .where(eq(containers.name, 'orphan-web-1'));

      expect(row).toBeDefined();
      expect(row.state).toBe('running');
      expect(row.stackId).toBeNull();
    }, 120_000);
  });
});
