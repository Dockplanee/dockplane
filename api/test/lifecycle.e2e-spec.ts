import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { AgentGatewayService } from '../src/agents/agent-gateway.service';
import { Database } from '../src/database/database';
import { DiscoveryService } from '../src/discovery/discovery.service';
import { actions, auditEntries, containers, events } from '../src/database/schema';
import { TestAgentConnection } from './agent-client';
import { createAgentCsr } from './agent-pki';
import {
  DEFAULT_PASSWORD,
  createTestApp,
  resetData,
  resetThrottling,
  seedUser,
  testPki,
} from './app';

const ORIGIN = 'http://localhost:4200';

interface Reply {
  capability: string;
  payload?: unknown;
  error?: { code: string; message: string };
  silent?: boolean;
}

/**
 * Container lifecycle over the real gateway.
 *
 * These are the first operations that change a host, so the tests are about
 * what reaches the agent and what does not: a request the operator was not
 * permitted to make, one that arrived twice, one for a host that is not
 * connected. A scripted agent records every capability it was asked for, which
 * is how "nothing was dispatched" can be asserted rather than assumed.
 */
describe('container lifecycle', () => {
  let app: INestApplication;
  let db: Database;
  let discovery: DiscoveryService;
  let port: number;
  let caPem: string;

  /** Every capability the agent received, across all connections. */
  let dispatched: string[] = [];

  const signIn = async (roleName: string) => {
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
      user,
      cookie: raw.find((entry) => entry.startsWith('dockplane_session='))!.split(';')[0],
      csrf: response.body.csrfToken as string,
    };
  };

  const enrollAgent = async (cookie: string, csrf: string) => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/agents/enrollment-tokens')
      .set('cookie', cookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', csrf)
      .send({ intendedHostname: 'docker-01' });

    const { csrPem, privateKeyPem } = await createAgentCsr();

    const enrolled = await request(app.getHttpServer())
      .post('/api/v1/agent-enrollments')
      .send({ token: created.body.token, csr: csrPem, protocolVersion: 1, hostname: 'docker-01' });

    return {
      agentId: enrolled.body.agentId as string,
      certificatePem: enrolled.body.certificate as string,
      privateKeyPem,
    };
  };

  const connectScripted = async (
    agent: { certificatePem: string; privateKeyPem: string },
    replies: Reply[],
  ) => {
    const connection = await TestAgentConnection.open({ port, caPem, ...agent });

    connection.send({ type: 'hello', protocolVersion: 1 });
    await connection.waitFor('hello_ack');

    connection.onMessage((message) => {
      if (message.type !== 'request') {
        return;
      }

      dispatched.push(String(message.capability));

      const scripted = replies.find((reply) => reply.capability === message.capability);

      if (!scripted || scripted.silent) {
        return;
      }

      connection.send({
        type: 'response',
        protocolVersion: 1,
        id: message.id,
        capability: message.capability,
        status: scripted.error ? 'error' : 'success',
        payload: scripted.payload,
        error: scripted.error,
      });
    });

    return connection;
  };

  const discoveryReplies = (state = 'running'): Reply[] => [
    {
      capability: 'host.inventory',
      payload: {
        hostname: 'docker-01',
        dockerVersion: '29.0.0',
        observedAt: new Date().toISOString(),
      },
    },
    { capability: 'host.metrics', payload: { cpuPercent: 5 } },
    {
      capability: 'container.list',
      payload: {
        containers: [
          {
            dockerId: 'aaa111',
            name: 'shop-web-1',
            image: 'nginx:1.27',
            state,
            status: state,
            health: 'none',
            createdAt: new Date().toISOString(),
          },
        ],
      },
    },
    { capability: 'compose.list', payload: { projects: [] } },
  ];

  const inspectReply = (state: string): Reply => ({
    capability: 'container.inspect',
    payload: {
      container: {
        dockerId: 'aaa111',
        name: 'shop-web-1',
        image: 'nginx:1.27',
        state,
        status: state,
        health: 'none',
        restartCount: 0,
        ports: [],
        networks: [],
        mounts: [],
        labels: {},
      },
      observedAt: new Date().toISOString(),
    },
  });

  const lifecycleReply = (capability: string, state: string): Reply => ({
    capability,
    payload: { dockerId: 'aaa111', state, health: 'none', observedAt: new Date().toISOString() },
  });

  /** Enrolls, connects, discovers one container and returns what to act on. */
  const ready = async (roleName: string, replies: Reply[], state = 'running') => {
    const admin = await signIn('Administrator');
    const agent = await enrollAgent(admin.cookie, admin.csrf);
    const connection = await connectScripted(agent, [...discoveryReplies(state), ...replies]);

    await discovery.sync(agent.agentId);

    const [container] = await db.client.select().from(containers);
    const operator = roleName === 'Administrator' ? admin : await signIn(roleName);

    dispatched = [];

    return { connection, container, agent, operator };
  };

  const act = (operation: string, containerId: string, session: { cookie: string; csrf: string }) =>
    request(app.getHttpServer())
      .post(`/api/v1/containers/${containerId}/${operation}`)
      .set('cookie', session.cookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', session.csrf)
      .send({});

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(Database);
    discovery = app.get(DiscoveryService);
    port = app.get(AgentGatewayService).port;
    caPem = (await testPki()).caCertPem;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetData(db);
    resetThrottling(app);
    dispatched = [];
  });

  describe('authorization', () => {
    /**
     * A refusal reaches no host.
     *
     * The permission is checked before an action is recorded, before an agent
     * is chosen and before anything is sent, so a request an operator may not
     * make leaves no trace on the machine it was aimed at.
     */
    it('dispatches nothing when the permission is missing', async () => {
      const { connection, container, operator } = await ready('Read Only', []);

      const response = await act('stop', container.id, operator);

      expect(response.status).toBe(403);
      expect(dispatched).toEqual([]);
      expect(await db.client.select().from(actions)).toHaveLength(0);

      connection.close();
    });

    it('refuses an unauthenticated caller without dispatching', async () => {
      const { connection, container } = await ready('Administrator', []);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/containers/${container.id}/start`)
        .set('origin', ORIGIN)
        .send({});

      expect(response.status).toBe(401);
      expect(dispatched).toEqual([]);

      connection.close();
    });

    it('separates the three permissions', async () => {
      const { connection, container, operator } = await ready(
        'Operator',
        [lifecycleReply('container.restart', 'running'), inspectReply('running')],
        'running',
      );

      // Operator carries restart but not stop.
      expect((await act('restart', container.id, operator)).status).toBe(200);
      expect((await act('stop', container.id, operator)).status).toBe(403);

      connection.close();
    });
  });

  describe('operations', () => {
    it('starts a stopped container and reports the observed state', async () => {
      const { connection, container, operator } = await ready(
        'Administrator',
        [lifecycleReply('container.start', 'running'), inspectReply('running')],
        'exited',
      );

      const response = await act('start', container.id, operator);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('succeeded');
      expect(dispatched).toContain('container.start');
      // The answer describes the host after the operation, not the request.
      expect(dispatched).toContain('container.inspect');
      expect(response.body.state).toBe('running');

      connection.close();
    });

    /**
     * The projection cache is not an answer to "what did the operation do".
     *
     * A container inspected seconds before the operation is recent enough to be
     * served from storage on an ordinary read. Serving it here would report the
     * state from before the start as the state the start produced, which is the
     * one thing this response must never do.
     */
    it('asks the host again rather than reporting a projection read before the operation', async () => {
      const inspect = inspectReply('exited');
      const { connection, container, operator } = await ready(
        'Administrator',
        [lifecycleReply('container.start', 'running'), inspect],
        'exited',
      );

      // A detail read moments earlier leaves a fresh projection behind.
      await request(app.getHttpServer())
        .get(`/api/v1/containers/${container.id}`)
        .set('cookie', operator.cookie);

      expect(dispatched).toContain('container.inspect');

      dispatched = [];
      inspect.payload = inspectReply('running').payload;

      const response = await act('start', container.id, operator);

      expect(dispatched).toContain('container.inspect');
      expect(response.body.state).toBe('running');

      connection.close();
    });

    it('reports a container that was already running', async () => {
      const { connection, container, operator } = await ready('Administrator', [
        {
          capability: 'container.start',
          error: { code: 'CONTAINER_ALREADY_RUNNING', message: 'already running' },
        },
      ]);

      const response = await act('start', container.id, operator);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONTAINER_ALREADY_RUNNING');

      const [action] = await db.client.select().from(actions);
      expect(action.status).toBe('failed');
      expect(action.errorCode).toBe('CONTAINER_ALREADY_RUNNING');

      connection.close();
    });

    it('stops a running container', async () => {
      const { connection, container, operator } = await ready('Administrator', [
        lifecycleReply('container.stop', 'exited'),
        inspectReply('exited'),
      ]);

      const response = await act('stop', container.id, operator);

      expect(response.status).toBe(200);
      expect(dispatched).toContain('container.stop');
      expect(response.body.state).toBe('exited');

      connection.close();
    });

    it('reports a container that was already stopped', async () => {
      const { connection, container, operator } = await ready('Administrator', [
        {
          capability: 'container.stop',
          error: { code: 'CONTAINER_ALREADY_STOPPED', message: 'not running' },
        },
      ]);

      const response = await act('stop', container.id, operator);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONTAINER_ALREADY_STOPPED');

      connection.close();
    });

    /**
     * Restart is one operation, not a stop followed by a start.
     *
     * Composing it here would leave the record describing two actions where the
     * operator asked for one, and a failure between them would read as a stop
     * that was meant all along.
     */
    it('restarts with a single dispatch', async () => {
      const { connection, container, operator } = await ready('Administrator', [
        lifecycleReply('container.restart', 'running'),
        inspectReply('running'),
      ]);

      await act('restart', container.id, operator);

      expect(dispatched.filter((name) => name === 'container.restart')).toHaveLength(1);
      expect(dispatched).not.toContain('container.stop');
      expect(dispatched).not.toContain('container.start');

      connection.close();
    });

    it('answers 404 for a container that does not exist', async () => {
      const { connection, operator } = await ready('Administrator', []);

      const response = await act('start', '00000000-0000-4000-8000-000000000000', operator);

      expect(response.status).toBe(404);
      expect(dispatched).toEqual([]);

      connection.close();
    });
  });

  describe('agent state', () => {
    /**
     * An operation is carried out now or refused.
     *
     * Nothing is queued for a host that is not connected: a stop asked for
     * while a machine was unreachable must not arrive hours later and take a
     * service down that nobody is watching.
     */
    it('refuses when the agent is not connected and queues nothing', async () => {
      const { connection, container, operator } = await ready('Administrator', []);

      connection.close();
      await connection.waitForClose();

      const response = await act('stop', container.id, operator);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('AGENT_OFFLINE');
      expect(dispatched).toEqual([]);
      expect(await db.client.select().from(actions)).toHaveLength(0);
    });

    it('refuses when the agent has been revoked', async () => {
      const admin = await signIn('Administrator');
      const agent = await enrollAgent(admin.cookie, admin.csrf);
      const connection = await connectScripted(agent, discoveryReplies());

      await discovery.sync(agent.agentId);

      const [container] = await db.client.select().from(containers);

      await request(app.getHttpServer())
        .post(`/api/v1/agents/${agent.agentId}/revoke`)
        .set('cookie', admin.cookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', admin.csrf)
        .send({ reason: 'test' });

      await connection.waitForClose();
      dispatched = [];

      const response = await act('restart', container.id, admin);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('AGENT_REVOKED');
      expect(dispatched).toEqual([]);
    });

    it('records a timeout and re-reads the container', async () => {
      const { connection, container, operator } = await ready('Administrator', [
        { capability: 'container.stop', silent: true },
        inspectReply('running'),
      ]);

      const response = await act('stop', container.id, operator);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('timed_out');

      const [action] = await db.client.select().from(actions);
      expect(action.status).toBe('timed_out');

      // A timeout says the server stopped waiting, not that Docker did nothing,
      // so the container is read again rather than assumed unchanged.
      expect(dispatched).toContain('container.inspect');

      connection.close();
    }, 120_000);
  });

  describe('concurrency', () => {
    /**
     * One operation per container at a time.
     *
     * With two in flight neither the operator nor the record could say which
     * produced the state that resulted, so the second is refused rather than
     * queued.
     */
    it('refuses a second operation on the same container', async () => {
      const { connection, container, operator } = await ready('Administrator', [
        { capability: 'container.restart', silent: true },
        inspectReply('running'),
      ]);

      // supertest sends on await, so the first request is kicked off
      // explicitly; otherwise the second would find nothing in flight.
      const first = act('restart', container.id, operator).then(
        (response) => response,
        () => undefined,
      );

      await new Promise((resolve) => setTimeout(resolve, 300));

      const second = await act('stop', container.id, operator);

      expect(second.status).toBe(409);
      expect(second.body.code).toBe('ACTION_CONFLICT');
      expect(dispatched.filter((name) => name === 'container.stop')).toHaveLength(0);

      await first;
      connection.close();
    }, 180_000);
  });

  describe('records', () => {
    it('keeps an action with its actor, target and duration', async () => {
      const { connection, container, operator } = await ready('Administrator', [
        lifecycleReply('container.restart', 'running'),
        inspectReply('running'),
      ]);

      await act('restart', container.id, operator);

      const [action] = await db.client.select().from(actions);

      expect(action.capability).toBe('container.restart');
      expect(action.status).toBe('succeeded');
      expect(action.targetId).toBe(container.id);
      expect(action.actorUserId).toBe(operator.user.id);
      expect(action.startedAt).not.toBeNull();
      expect(action.completedAt).not.toBeNull();

      connection.close();
    });

    it('audits the request and its outcome', async () => {
      const { connection, container, operator } = await ready('Administrator', [
        lifecycleReply('container.stop', 'exited'),
        inspectReply('exited'),
      ]);

      await act('stop', container.id, operator);

      const trail = await db.client.select().from(auditEntries);
      const recorded = trail.map((entry) => entry.action);

      expect(recorded).toContain('container.stop.requested');
      expect(recorded).toContain('container.stop.succeeded');

      // Nothing from Docker's own vocabulary ends up in the trail.
      expect(JSON.stringify(trail)).not.toContain('nginx:1.27');

      connection.close();
    });

    it('records an operational event for the change', async () => {
      const { connection, container, operator } = await ready('Administrator', [
        lifecycleReply('container.restart', 'running'),
        inspectReply('running'),
      ]);

      await act('restart', container.id, operator);

      const recorded = await db.client
        .select()
        .from(events)
        .where(eq(events.type, 'container.restarted'));

      expect(recorded).toHaveLength(1);

      connection.close();
    });

    it('lists actions for anyone who may read containers', async () => {
      const { connection, container, operator } = await ready(
        'Administrator',
        [lifecycleReply('container.start', 'running'), inspectReply('running')],
        'exited',
      );

      await act('start', container.id, operator);

      const response = await request(app.getHttpServer())
        .get('/api/v1/actions')
        .set('cookie', operator.cookie);

      expect(response.status).toBe(200);
      expect(response.body.actions).toHaveLength(1);
      expect(response.body.actions[0].capability).toBe('container.start');
      expect(response.body.actions[0].containerName).toBe('shop-web-1');
      expect(typeof response.body.actions[0].durationMs).toBe('number');

      connection.close();
    });
  });
});
