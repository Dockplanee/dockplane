import { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';

import { AgentGatewayService } from '../src/agents/agent-gateway.service';
import { PendingMutationGuard } from '../src/containers/pending-guard';
import { Database } from '../src/database/database';
import { DiscoveryService } from '../src/discovery/discovery.service';
import { containerDesiredConfigs, containers, hosts } from '../src/database/schema';
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
}

/**
 * What an unfinished mutation blocks.
 *
 * The in-memory lock covers two operations racing inside one process. It does
 * not cover the case this is about: a control server that died partway through
 * a replacement, leaving a container whose state nobody can describe until
 * reconciliation says which configuration Docker actually applied.
 *
 * These tests never run a mutation. The candidate row is written directly and
 * the application is asked to operate on the container — so nothing is holding
 * an in-memory lock, and a refusal can only be coming from the database. That
 * is the same position the process is in after a restart.
 */
describe('an unfinished mutation', () => {
  let app: INestApplication;
  let db: Database;
  let discovery: DiscoveryService;
  let guard: PendingMutationGuard;
  let port: number;
  let caPem: string;

  /** Every capability the agent was asked for, so refusals can be proven. */
  let dispatched: string[] = [];

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

  const enrollAgent = async (session: { cookie: string; csrf: string }) => {
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

      if (!scripted) {
        return;
      }

      connection.send({
        type: 'response',
        protocolVersion: 1,
        id: message.id,
        capability: message.capability,
        status: 'success',
        payload: scripted.payload,
      });
    });

    return connection;
  };

  const discoveryReplies = (): Reply[] => [
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
            state: 'running',
            status: 'running',
            health: 'none',
            createdAt: new Date().toISOString(),
          },
        ],
      },
    },
    { capability: 'compose.list', payload: { projects: [] } },
    /*
     * The tests where the guard is supposed to let an operation through send a
     * real restart, and an agent that never answers one is not what those tests
     * are about: the server waits out the capability's whole timeout, four
     * times over, for a reply the assertions do not even read. The host answers
     * as a host does, and what is under test — that the request was dispatched
     * at all — is unchanged.
     */
    {
      capability: 'container.restart',
      payload: {
        dockerId: 'aaa111',
        state: 'running',
        health: 'none',
        observedAt: new Date().toISOString(),
      },
    },
  ];

  /** Enrolls, connects and discovers one container to operate on. */
  const ready = async () => {
    const session = await signIn();
    const agent = await enrollAgent(session);
    const connection = await connectScripted(agent, discoveryReplies());

    await discovery.sync(agent.agentId);

    const [container] = await db.client.select().from(containers);

    dispatched = [];

    return { connection, container, agent, session };
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
    guard = app.get(PendingMutationGuard);
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

  describe('a candidate configuration nobody is applying', () => {
    it('refuses every operation on the container, and dispatches none', async () => {
      const { connection, container, session } = await ready();

      await db.client
        .insert(containerDesiredConfigs)
        .values({ containerId: container.id, state: 'pending', image: 'nginx:1.28' });

      for (const operation of ['start', 'stop', 'restart']) {
        const response = await act(operation, container.id, session);

        expect(response.status).toBe(409);
        expect(response.body.code).toBe('ACTION_CONFLICT');
      }

      // Not one of them reached the host. A container in an undetermined state
      // is one no operation has a defined meaning for.
      expect(dispatched).toEqual([]);

      connection.close();
    }, 180_000);

    it('lets the same operations through once it is resolved', async () => {
      const { connection, container, session } = await ready();

      const [pending] = await db.client
        .insert(containerDesiredConfigs)
        .values({ containerId: container.id, state: 'pending', image: 'nginx:1.28' })
        .returning({ id: containerDesiredConfigs.id });

      expect((await act('restart', container.id, session)).status).toBe(409);

      // What finalising a discarded candidate does.
      await db.client
        .delete(containerDesiredConfigs)
        .where(eq(containerDesiredConfigs.id, pending.id));

      const response = await act('restart', container.id, session);

      expect(response.status).toBeLessThan(400);
      expect(dispatched).toContain('container.restart');

      connection.close();
    }, 180_000);

    it('does not block a container that merely has a configuration', async () => {
      const { connection, container, session } = await ready();

      // Current is what the container is. Only a candidate is undetermined.
      await db.client
        .insert(containerDesiredConfigs)
        .values({ containerId: container.id, state: 'current', image: 'nginx:1.27' });

      const response = await act('restart', container.id, session);

      expect(response.status).toBeLessThan(400);

      connection.close();
    }, 180_000);

    it('does not block the container next to it', async () => {
      const { connection, container, session } = await ready();

      const [other] = await db.client
        .insert(containers)
        .values({
          hostId: container.hostId,
          dockerId: 'bbb222',
          name: 'shop-api-1',
          image: 'nginx:1.27',
          state: 'running',
          observedAt: new Date(),
        })
        .returning({ id: containers.id });

      await db.client
        .insert(containerDesiredConfigs)
        .values({ containerId: other.id, state: 'pending', image: 'nginx:1.28' });

      const response = await act('restart', container.id, session);

      expect(response.status).toBeLessThan(400);

      connection.close();
    }, 180_000);
  });

  /*
   * A create holds a name rather than a container, because there is no
   * container yet. The resource is written first so that a control server which
   * dies mid-create can find out afterwards whether Docker made anything — and
   * that row is what keeps the name held across the restart.
   */
  describe('a create that never finished', () => {
    /** What a create writes before it asks the agent for anything. */
    const reserve = async (hostId: string, name: string) => {
      const [row] = await db.client
        .insert(containers)
        .values({
          hostId,
          dockerId: null,
          name,
          image: 'nginx:1.27',
          state: 'creating',
          observedAt: new Date(),
        })
        .returning({ id: containers.id });

      await db.client
        .insert(containerDesiredConfigs)
        .values({ containerId: row.id, state: 'pending', image: 'nginx:1.27' });

      return row.id;
    };

    it('keeps its name, so a second create of it cannot start', async () => {
      const { connection, container } = await ready();

      await reserve(container.hostId, 'shop-api-1');

      await expect(guard.assertNameFree(container.hostId, 'shop-api-1')).rejects.toMatchObject({
        code: 'CONTAINER_NAME_IN_USE',
      });

      connection.close();
    }, 180_000);

    it('holds the name however it is spelled', async () => {
      const { connection, container } = await ready();

      await reserve(container.hostId, 'Shop-API-1');

      await expect(guard.assertNameFree(container.hostId, 'shop-api-1')).rejects.toMatchObject({
        code: 'CONTAINER_NAME_IN_USE',
      });

      connection.close();
    }, 180_000);

    it('is refused by the database as well, not only by the query', async () => {
      // Two requests can both read an unreserved name before either writes.
      const { connection, container } = await ready();

      await reserve(container.hostId, 'shop-api-1');

      await expect(reserve(container.hostId, 'shop-api-1')).rejects.toThrow();

      connection.close();
    }, 180_000);

    it('holds it only on its own host', async () => {
      const { connection, container } = await ready();

      await reserve(container.hostId, 'shop-api-1');

      const [elsewhere] = await db.client
        .insert(hosts)
        .values({ hostname: `docker-02-${Date.now()}`, observedAt: new Date() })
        .returning({ id: hosts.id });

      // The same name on a different host is a different container entirely.
      await expect(guard.assertNameFree(elsewhere.id, 'shop-api-1')).resolves.toBeUndefined();

      connection.close();
    }, 180_000);

    it('stops holding it once the create resolves', async () => {
      const { connection, container } = await ready();

      const reserved = await reserve(container.hostId, 'shop-api-1');

      // What finalising a discarded create does: the resource goes, and the
      // candidate configuration goes with it.
      await db.client.delete(containers).where(eq(containers.id, reserved));

      await expect(guard.assertNameFree(container.hostId, 'shop-api-1')).resolves.toBeUndefined();

      connection.close();
    }, 180_000);

    it('survives the discovery sweep that removes what a host no longer has', async () => {
      const { connection, container, agent } = await ready();

      const [reserved] = await db.client
        .insert(containers)
        .values({
          hostId: container.hostId,
          dockerId: null,
          name: 'shop-api-1',
          image: 'nginx:1.27',
          state: 'creating',
          observedAt: new Date(),
        })
        .returning({ id: containers.id });

      await db.client
        .insert(containerDesiredConfigs)
        .values({ containerId: reserved.id, state: 'pending', image: 'nginx:1.27' });

      /*
       * A complete pass that does not mention it. For an ordinary container
       * that means it is gone; for one that was never on the host it means
       * nothing at all, and sweeping it would take the record of the
       * unfinished create with it.
       */
      const result = await discovery.sync(agent.agentId);

      expect(result.complete).toBe(true);

      const [survivor] = await db.client
        .select()
        .from(containers)
        .where(eq(containers.id, reserved.id));

      expect(survivor).toBeDefined();

      const [candidate] = await db.client
        .select()
        .from(containerDesiredConfigs)
        .where(
          and(
            eq(containerDesiredConfigs.containerId, reserved.id),
            eq(containerDesiredConfigs.state, 'pending'),
          ),
        );

      expect(candidate).toBeDefined();

      connection.close();
    }, 180_000);
  });
});
