import { INestApplication } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { AgentGatewayService } from '../src/agents/agent-gateway.service';
import { SecretBox } from '../src/common/crypto';
import { SECRET_BOX } from '../src/config/tokens';
import { Database } from '../src/database/database';
import { DiscoveryService } from '../src/discovery/discovery.service';
import {
  actions,
  auditEntries,
  composeProjects,
  containerDesiredConfigs,
  containerEnvironmentVariables,
  containers,
} from '../src/database/schema';
import { MutationRegistry } from '../src/operations/mutation-registry';
import { RecoveryOrchestrator } from '../src/containers/recovery.orchestrator';
import { TestAgentConnection } from './agent-client';
import { createAgentCsr } from './agent-pki';
import { prepareDatabase } from './database';
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

/** Something that would be unmistakable if it ever escaped. */
const CANARY = 'canary-secret-1c0ffee-do-not-store';
const SECOND_CANARY = 'canary-secret-2deadbeef-do-not-store';

/**
 * Creating, replacing and removing containers, end to end.
 *
 * The agent side is a real mTLS connection in front of a small model of a
 * Docker host: a create adds a container to it, a replace exchanges one, a
 * remove takes one away, and listing it is how the server finds out. So the
 * assertions are about what the server concluded from reading a host, not about
 * what a mock was told to reply — and a host that quietly did not do what it
 * was asked is something these tests can arrange.
 */
describe('changing what a container is', () => {
  let app: INestApplication;
  let db: Database;
  let discovery: DiscoveryService;
  let mutations: MutationRegistry;
  let recovery: RecoveryOrchestrator;
  let box: SecretBox;
  let port: number;
  let caPem: string;

  let host: FakeDockerHost;
  let connection: TestAgentConnection;
  let agentId: string;
  let hostId: string;
  let session: { cookie: string; csrf: string };

  /** Capabilities the server dispatched, so "nothing was sent" is provable. */
  let dispatched: string[] = [];

  /**
   * Capabilities the host takes and then loses its connection over.
   *
   * The realistic shape of an unknown outcome: the request arrived, Docker may
   * have acted on it, and the answer went with the socket. Waiting out a
   * dispatch timeout would test the same server behaviour several minutes more
   * slowly, and this is closer to what actually happens to a host.
   */
  let dropOn = new Set<string>();

  /** Capabilities the host is slow to answer, in milliseconds. */
  let holdFor = new Map<string, number>();

  /** Kept so the agent can come back after its connection is lost. */
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

  /** Enrolls an agent and connects it in front of the fake host. */
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

  /** Opens a connection for the enrolled agent, in front of the same host. */
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

      /*
       * The request arrived and the connection dies before the answer. Whether
       * Docker acted on it is exactly what the server cannot know.
       */
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

      const send = () =>
        opened.send({
          type: 'response',
          protocolVersion: 1,
          id: message.id,
          capability: message.capability,
          ...response,
        });

      // A host that takes its time, so a request can be observed mid-operation.
      const held = holdFor.get(capability);

      if (held) {
        setTimeout(send, held);
        return;
      }

      send();
    });

    return opened;
  };

  /** Brings the agent back, as a reconnecting agent does. */
  const reconnect = async () => {
    dropOn = new Set();
    connection = await openConnection();

    // The gateway registers the connection a moment after the handshake.
    await new Promise((resolve) => setTimeout(resolve, 250));
  };

  const create = (body: unknown) =>
    request(app.getHttpServer())
      .post('/api/v1/containers')
      .set('cookie', session.cookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', session.csrf)
      .send(body as object);

  const replace = (id: string, body: unknown) =>
    request(app.getHttpServer())
      .put(`/api/v1/containers/${id}`)
      .set('cookie', session.cookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', session.csrf)
      .send(body as object);

  const remove = (id: string, body: unknown = {}) =>
    request(app.getHttpServer())
      .delete(`/api/v1/containers/${id}`)
      .set('cookie', session.cookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', session.csrf)
      .send(body as object);

  const lifecycle = (operation: string, id: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/containers/${id}/${operation}`)
      .set('cookie', session.cookie)
      .set('origin', ORIGIN)
      .set('x-csrf-token', session.csrf)
      .send({});

  const spec = (overrides: Record<string, unknown> = {}) => ({
    hostId,
    name: `svc-${Math.round(Math.random() * 1e6)}`,
    image: 'nginx:1.27',
    ...overrides,
  });

  const configs = (containerId: string) =>
    db.client
      .select()
      .from(containerDesiredConfigs)
      .where(eq(containerDesiredConfigs.containerId, containerId));

  const environment = (desiredConfigId: string) =>
    db.client
      .select()
      .from(containerEnvironmentVariables)
      .where(eq(containerEnvironmentVariables.desiredConfigId, desiredConfigId));

  /** Creates one container the ordinary way and returns what it produced. */
  const created = async (overrides: Record<string, unknown> = {}) => {
    const body = spec(overrides);
    const response = await create(body);

    expect(response.status).toBe(201);

    return { id: response.body.containerId as string, name: body.name, response };
  };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(Database);
    discovery = app.get(DiscoveryService);
    mutations = app.get(MutationRegistry);
    recovery = app.get(RecoveryOrchestrator);
    box = app.get(SECRET_BOX);
    port = app.get(AgentGatewayService).port;
    caPem = (await testPki()).caCertPem;
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetData(db);
    resetThrottling(app);

    host = new FakeDockerHost();
    dispatched = [];
    dropOn = new Set();
    holdFor = new Map();

    session = await signIn();
    connection = await connectAgent();

    // The host exists once the agent has enrolled; one pass registers it.
    const sync = await discovery.sync(agentId);
    hostId = sync.hostId;
  }, 120_000);

  afterEach(() => {
    connection?.close();
  });

  describe('creating', () => {
    it('reports the container as managed, and an external one as external', async () => {
      const { id } = await created();

      host.seed('somebody-elses');
      await discovery.sync(agentId);

      const listing = await request(app.getHttpServer())
        .get('/api/v1/containers')
        .set('cookie', session.cookie)
        .set('origin', ORIGIN);

      const rows = listing.body.containers as {
        id: string;
        name: string;
        management: { kind: string; reconciling: boolean; identityConflict: boolean };
      }[];

      const managed = rows.find((row) => row.id === id)!;
      const external = rows.find((row) => row.name === 'somebody-elses')!;

      expect(managed.management).toEqual({
        kind: 'managed',
        reconciling: false,
        identityConflict: false,
      });

      expect(external.management.kind).toBe('external');
    }, 60_000);

    it('creates the container and reports the resource it became', async () => {
      const { id, name } = await created();

      // The host has it, carrying the identity the server allocated.
      const built = host.claiming(id);

      expect(built).toBeDefined();
      expect(built!.name).toBe(name);
      expect(built!.labels['io.dockplane.managed']).toBe('true');

      const rows = await configs(id);

      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('current');
      // The configuration it carries is the one that became current.
      expect(built!.labels['io.dockplane.desired-config-id']).toBe(rows[0].id);

      const [row] = await db.client.select().from(containers).where(eq(containers.id, id));

      expect(row.dockerId).toBe(built!.dockerId);
      expect(row.state).toBe('running');
    }, 60_000);

    it('closes the action and audits the outcome', async () => {
      const { id, response } = await created();

      const [action] = await db.client
        .select()
        .from(actions)
        .where(eq(actions.id, response.body.actionId));

      expect(action.status).toBe('succeeded');
      expect(action.capability).toBe('container.create');
      expect(action.targetId).toBe(id);

      const recorded = await db.client
        .select()
        .from(auditEntries)
        .where(eq(auditEntries.targetId, id));

      expect(recorded.map((entry) => entry.action)).toEqual(
        expect.arrayContaining(['container.create.requested', 'container.create.succeeded']),
      );
    }, 60_000);

    it('stores a secret encrypted and never returns it', async () => {
      const { id, response } = await created({
        environment: [
          { operation: 'set', key: 'LOG_LEVEL', value: 'debug' },
          { operation: 'set-secret', key: 'DB_PASSWORD', value: CANARY },
        ],
      });

      const [config] = await configs(id);
      const stored = await environment(config.id);
      const secret = stored.find((variable) => variable.key === 'DB_PASSWORD')!;

      expect(secret.isSecret).toBe(true);
      expect(secret.value).toBeNull();
      expect(box.decrypt(secret.valueEncrypted!)).toBe(CANARY);

      // And the plain variable is stored as one, in the other column.
      const plain = stored.find((variable) => variable.key === 'LOG_LEVEL')!;

      expect(plain.value).toBe('debug');
      expect(plain.valueEncrypted).toBeNull();

      expect(JSON.stringify(response.body)).not.toContain(CANARY);
    }, 60_000);

    it('refuses a second container with the same name on that host', async () => {
      const body = spec();

      expect((await create(body)).status).toBe(201);

      const second = await create(body);

      expect(second.status).toBe(409);
      expect(second.body.code).toBe('CONTAINER_NAME_IN_USE');
    }, 60_000);

    /*
     * A host that accepted the request and made nothing.
     *
     * The agent reported success, so believing the reply would leave Dockplane
     * showing a container that does not exist. The complete listing afterwards
     * is what settles it.
     */
    it('does not believe a success the host cannot show', async () => {
      host.silentlyIgnore.add('container.create');

      const response = await create(spec());

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONTAINER_CREATE_FAILED');

      // The resource went with the create that never happened, which is also
      // what releases the name.
      expect(await db.client.select().from(containers)).toHaveLength(0);
    }, 60_000);

    it('reports an agent that refused, and leaves nothing behind', async () => {
      host.failWith.set('container.create', {
        code: 'IMAGE_NOT_FOUND',
        message: 'No such image.',
      });

      const response = await create(spec({ image: 'nginx:absent' }));

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('IMAGE_NOT_FOUND');
      expect(await db.client.select().from(containers)).toHaveLength(0);
    }, 60_000);
  });

  describe('replacing', () => {
    it('keeps the resource and gives it a new container', async () => {
      const { id, name } = await created({ image: 'nginx:1.27' });
      const before = host.claiming(id)!;

      const response = await replace(id, { name, image: 'nginx:1.28' });

      expect(response.status).toBe(200);

      const after = host.claiming(id)!;

      expect(after.dockerId).not.toBe(before.dockerId);
      expect(after.image).toBe('nginx:1.28');

      const [row] = await db.client.select().from(containers).where(eq(containers.id, id));

      // Same Dockplane container, different Docker one.
      expect(row.id).toBe(id);
      expect(row.dockerId).toBe(after.dockerId);

      const rows = await configs(id);

      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('current');
      expect(rows[0].image).toBe('nginx:1.28');
      expect(after.labels['io.dockplane.desired-config-id']).toBe(rows[0].id);
    }, 60_000);

    /*
     * The case the configuration identity exists for.
     *
     * Nothing observable changes: same image, same ports, same name. Only a
     * secret is different, and secrets are never in observed state.
     */
    it('applies a change that consists of one secret', async () => {
      const { id, name } = await created({
        environment: [{ operation: 'set-secret', key: 'DB_PASSWORD', value: CANARY }],
      });

      const [first] = await configs(id);

      const response = await replace(id, {
        name,
        image: 'nginx:1.27',
        environment: [{ operation: 'set-secret', key: 'DB_PASSWORD', value: SECOND_CANARY }],
      });

      expect(response.status).toBe(200);

      const rows = await configs(id);

      expect(rows).toHaveLength(1);
      expect(rows[0].id).not.toBe(first.id);

      const [secret] = await environment(rows[0].id);

      expect(box.decrypt(secret.valueEncrypted!)).toBe(SECOND_CANARY);

      // The old configuration and its value are gone with it.
      expect(await environment(first.id)).toHaveLength(0);
    }, 60_000);

    it('carries an unchanged secret across without the browser having it', async () => {
      const { id, name } = await created({
        environment: [{ operation: 'set-secret', key: 'DB_PASSWORD', value: CANARY }],
      });

      const [first] = await configs(id);
      const [before] = await environment(first.id);

      const response = await replace(id, {
        name,
        image: 'nginx:1.28',
        // What a form sends back for a value it was never shown.
        environment: [{ operation: 'unchanged', key: 'DB_PASSWORD' }],
      });

      expect(response.status).toBe(200);

      const [config] = await configs(id);
      const [after] = await environment(config.id);

      // The same envelope, not a re-encryption: nothing decrypted it.
      expect(after.valueEncrypted).toBe(before.valueEncrypted);
      expect(box.decrypt(after.valueEncrypted!)).toBe(CANARY);
    }, 60_000);

    it('refuses to keep a variable the container does not have', async () => {
      const { id, name } = await created();

      const response = await replace(id, {
        name,
        image: 'nginx:1.27',
        environment: [{ operation: 'unchanged', key: 'NEVER_SET' }],
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_CONTAINER_SPEC');

      // And the container is untouched: nothing was dispatched for it.
      expect(dispatched.filter((name) => name === 'container.replace')).toHaveLength(0);
    }, 60_000);

    it('keeps the original when the replacement rolls back', async () => {
      const { id, name } = await created();
      const before = host.claiming(id)!;

      host.silentlyIgnore.add('container.replace');

      const response = await replace(id, { name, image: 'nginx:1.28' });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('REPLACEMENT_FAILED');

      const rows = await configs(id);

      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('current');
      // Still the configuration that is running.
      expect(rows[0].image).toBe('nginx:1.27');

      const [row] = await db.client.select().from(containers).where(eq(containers.id, id));

      expect(row.dockerId).toBe(before.dockerId);
    }, 60_000);
  });

  describe('removing', () => {
    it('removes the container and everything it was configured with', async () => {
      const { id } = await created({
        environment: [{ operation: 'set-secret', key: 'DB_PASSWORD', value: CANARY }],
      });

      const [config] = await configs(id);
      const response = await remove(id);

      expect(response.status).toBe(200);
      expect(host.claiming(id)).toBeUndefined();

      expect(await db.client.select().from(containers).where(eq(containers.id, id))).toHaveLength(
        0,
      );
      expect(await configs(id)).toHaveLength(0);
      // The secret went with it: a removal that left it behind removed little.
      expect(await environment(config.id)).toHaveLength(0);
    }, 60_000);

    it('reports a removal that did not happen, and removes nothing', async () => {
      const { id } = await created();

      host.silentlyIgnore.add('container.remove');

      const response = await remove(id);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONTAINER_REMOVE_FAILED');
      expect(await db.client.select().from(containers).where(eq(containers.id, id))).toHaveLength(
        1,
      );
    }, 60_000);
  });

  /*
   * The outcome the server cannot learn.
   *
   * The request reached the host and the answer never came back. Docker may
   * have done exactly what was asked, so every response here is about refusing
   * to claim otherwise — and about making sure a client that retries cannot
   * start a second change on top of the first.
   */
  describe('when the answer never comes back', () => {
    it('says the outcome is unknown rather than that it failed', async () => {
      dropOn.add('container.create');

      const response = await create(spec());

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('OPERATION_OUTCOME_UNKNOWN');
      expect(String(response.body.message)).not.toMatch(/failed/i);
    }, 120_000);

    it('keeps the create open, and holds its name against a retry', async () => {
      dropOn.add('container.create');

      const body = spec();

      expect((await create(body)).status).toBe(503);

      const [action] = await db.client.select().from(actions);

      // Unresolved, not failed: nothing established that it failed.
      expect(action.status).toBe('running');

      const [row] = await db.client.select().from(containers);

      expect(row.dockerId).toBeNull();
      expect((await configs(row.id))[0].state).toBe('pending');

      // The agent comes back, and the client retries, as clients do.
      await reconnect();

      const retry = await create(body);

      expect(retry.status).toBe(409);
      expect(retry.body.code).toBe('CONTAINER_NAME_IN_USE');
      expect(dispatched.filter((name) => name === 'container.create')).toHaveLength(1);
    }, 120_000);

    it('audits it as interrupted, never as failed', async () => {
      dropOn.add('container.create');

      await create(spec());

      const recorded = await db.client.select().from(auditEntries);
      const kinds = recorded.map((entry) => entry.action);

      expect(kinds).toContain('container.create.interrupted');
      expect(kinds).not.toContain('container.create.failed');
    }, 120_000);

    it('blocks every further change to a container mid-replacement', async () => {
      const { id, name } = await created();

      dropOn.add('container.replace');

      expect((await replace(id, { name, image: 'nginx:1.28' })).status).toBe(503);

      // The candidate is still there, so nothing may act on the container.
      expect((await configs(id)).some((row) => row.state === 'pending')).toBe(true);

      for (const response of [
        await replace(id, { name, image: 'nginx:1.29' }),
        await remove(id),
        await lifecycle('restart', id),
        await lifecycle('stop', id),
      ]) {
        expect(response.status).toBe(409);
        expect(response.body.code).toBe('ACTION_CONFLICT');
      }

      expect(dispatched.filter((name) => name === 'container.replace')).toHaveLength(1);
      expect(dispatched.filter((name) => name === 'container.restart')).toHaveLength(0);
    }, 120_000);

    it('keeps a removal open and blocks the container', async () => {
      const { id } = await created();

      dropOn.add('container.remove');

      expect((await remove(id)).status).toBe(503);

      const [action] = await db.client
        .select()
        .from(actions)
        .where(eq(actions.capability, 'container.remove'));

      expect(action.status).toBe('running');
      expect((await lifecycle('start', id)).body.code).toBe('ACTION_CONFLICT');
      expect(dispatched.filter((name) => name === 'container.remove')).toHaveLength(1);
    }, 120_000);
  });

  /*
   * What is left after the process that started an operation is gone.
   *
   * The in-memory lock does not survive a restart; the record does. These clear
   * the registry to stand in for a new process, and everything that follows
   * comes from the database and from reading the host.
   */
  describe('after the server that started it has gone', () => {
    /**
     * Stands in for a restart.
     *
     * A new process starts with an empty registry and a database that still
     * has everything. Emptying it here is the whole simulation: from this point
     * nothing in memory knows about the operation, and every refusal or
     * decision that follows came from the record and from reading the host.
     */
    const restart = () => {
      (mutations as unknown as { held: Map<string, string> }).held.clear();
    };

    it('still refuses a change to a container whose last one never resolved', async () => {
      const { id, name } = await created();

      dropOn.add('container.replace');
      await replace(id, { name, image: 'nginx:1.28' });

      restart();

      const response = await replace(id, { name, image: 'nginx:1.30' });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('ACTION_CONFLICT');
    }, 120_000);

    it('promotes the candidate when the host shows the replacement running', async () => {
      const { id, name } = await created();

      const [before] = await configs(id);

      dropOn.add('container.replace');
      await replace(id, { name, image: 'nginx:1.28' });

      const [candidate] = await db.client
        .select()
        .from(containerDesiredConfigs)
        .where(
          and(
            eq(containerDesiredConfigs.containerId, id),
            eq(containerDesiredConfigs.state, 'pending'),
          ),
        );

      /*
       * The host did apply it — the answer was simply lost. It is carrying the
       * candidate's identity, which is the only thing that says so.
       */
      const original = host.claiming(id)!;

      host.containers.delete(original.dockerId);
      host.seed(name, {
        'io.dockplane.managed': 'true',
        'io.dockplane.container-id': id,
        'io.dockplane.desired-config-id': candidate.id,
      });

      restart();
      await reconnect();

      await discovery.sync(agentId);
      await recovery.recoverHost(hostId);

      const rows = await configs(id);

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(candidate.id);
      expect(rows[0].state).toBe('current');
      expect(rows.some((row) => row.id === before.id)).toBe(false);

      const [action] = await db.client
        .select()
        .from(actions)
        .where(eq(actions.capability, 'container.replace'));

      expect(action.status).toBe('succeeded');

      // Reconciled, never repeated.
      expect(dispatched.filter((name) => name === 'container.replace')).toHaveLength(1);
    }, 120_000);

    it('discards the candidate when the host shows the original still running', async () => {
      const { id, name } = await created();
      const [before] = await configs(id);

      dropOn.add('container.replace');
      await replace(id, { name, image: 'nginx:1.28' });

      restart();
      await reconnect();

      // The host never applied it. The original is still carrying A.
      await discovery.sync(agentId);
      await recovery.recoverHost(hostId);

      const rows = await configs(id);

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(before.id);
      expect(rows[0].state).toBe('current');

      const [action] = await db.client
        .select()
        .from(actions)
        .where(eq(actions.capability, 'container.replace'));

      expect(action.status).toBe('failed');
      expect(action.errorCode).toBe('REPLACEMENT_FAILED');
      expect(dispatched.filter((name) => name === 'container.replace')).toHaveLength(1);
    }, 120_000);

    it('promotes a create whose container turns out to exist', async () => {
      dropOn.add('container.create');

      const body = spec();

      await create(body);

      const [row] = await db.client.select().from(containers);
      const [candidate] = await configs(row.id);

      // It was created; only the answer was lost.
      host.seed(body.name, {
        'io.dockplane.managed': 'true',
        'io.dockplane.container-id': row.id,
        'io.dockplane.desired-config-id': candidate.id,
      });

      restart();
      await reconnect();

      await discovery.sync(agentId);
      await recovery.recoverHost(hostId);

      const rows = await configs(row.id);

      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('current');

      const [after] = await db.client.select().from(containers).where(eq(containers.id, row.id));

      expect(after.dockerId).not.toBeNull();
      expect(dispatched.filter((name) => name === 'container.create')).toHaveLength(1);
    }, 120_000);

    it('discards a create the host never performed, releasing its name', async () => {
      dropOn.add('container.create');

      const body = spec();

      await create(body);

      restart();
      await reconnect();

      await discovery.sync(agentId);
      await recovery.recoverHost(hostId);

      expect(await db.client.select().from(containers)).toHaveLength(0);

      const [action] = await db.client.select().from(actions);

      expect(action.status).toBe('failed');
      expect(action.errorCode).toBe('CONTAINER_CREATE_FAILED');

      // The name is free again, and creating it now works normally.
      expect((await create(body)).status).toBe(201);
    }, 120_000);

    it('finishes a removal the host turns out to have performed', async () => {
      const { id } = await created();

      dropOn.add('container.remove');
      await remove(id);

      // It was removed; the answer was lost.
      const still = host.claiming(id);

      host.containers.delete(still!.dockerId);

      restart();
      await reconnect();

      await discovery.sync(agentId);
      await recovery.recoverHost(hostId);

      expect(await db.client.select().from(containers).where(eq(containers.id, id))).toHaveLength(
        0,
      );

      const [action] = await db.client
        .select()
        .from(actions)
        .where(eq(actions.capability, 'container.remove'));

      expect(action.status).toBe('succeeded');
      expect(dispatched.filter((name) => name === 'container.remove')).toHaveLength(1);
    }, 120_000);

    it('records a removal that did not happen, and leaves the container', async () => {
      const { id } = await created();

      dropOn.add('container.remove');
      await remove(id);

      restart();
      await reconnect();

      await discovery.sync(agentId);
      await recovery.recoverHost(hostId);

      expect(await db.client.select().from(containers).where(eq(containers.id, id))).toHaveLength(
        1,
      );

      const [action] = await db.client
        .select()
        .from(actions)
        .where(eq(actions.capability, 'container.remove'));

      expect(action.status).toBe('failed');
      expect(action.errorCode).toBe('CONTAINER_REMOVE_FAILED');

      // And the container works again, now that nothing is unresolved.
      expect((await lifecycle('restart', id)).status).toBe(200);
    }, 120_000);

    it('does not touch an operation somebody is still running', async () => {
      const { id, name } = await created();

      // A host that is taking its time. The request owns the container for as
      // long as it is waiting, which is the state being tested.
      holdFor.set('container.replace', 3_000);

      // supertest sends on await, so the request is kicked off explicitly;
      // otherwise there would be nothing in flight to leave alone.
      const inFlight = replace(id, { name, image: 'nginx:1.28' }).then((response) => response);

      await new Promise((resolve) => setTimeout(resolve, 500));

      /*
       * A recovery pass arriving mid-operation. The candidate is written and
       * the host has not applied it yet, which is exactly what an abandoned
       * replacement looks like — and acting on it would destroy an operation
       * that is going perfectly well.
       */
      await recovery.recoverHost(hostId);

      const during = await configs(id);

      expect(during.some((row) => row.state === 'pending')).toBe(true);

      const [action] = await db.client
        .select()
        .from(actions)
        .where(eq(actions.capability, 'container.replace'));

      expect(action.status).toBe('running');

      // And it finishes normally, as though nothing had happened.
      expect((await inFlight).status).toBe(200);

      const after = await configs(id);

      expect(after).toHaveLength(1);
      expect(after[0].state).toBe('current');
      expect(after[0].image).toBe('nginx:1.28');
    }, 180_000);

    it('concludes nothing from a host it could not read completely', async () => {
      const { id, name } = await created();
      const [before] = await configs(id);

      dropOn.add('container.replace');
      await replace(id, { name, image: 'nginx:1.28' });

      restart();
      await reconnect();

      // The agent is back, but its Docker daemon is not answering. A listing
      // that failed says nothing about which containers exist.
      host.failWith.set('container.list', {
        code: 'DOCKER_UNAVAILABLE',
        message: 'The daemon is not reachable.',
      });

      await recovery.recoverHost(hostId);

      const rows = await configs(id);

      // Both still there: absence from a reading that failed is not evidence.
      expect(rows).toHaveLength(2);
      expect(rows.some((row) => row.id === before.id && row.state === 'current')).toBe(true);
      expect(rows.some((row) => row.state === 'pending')).toBe(true);
    }, 120_000);
  });

  describe('what may not be changed', () => {
    it('refuses a container Dockplane did not create', async () => {
      host.seed('somebody-elses');

      await discovery.sync(agentId);

      const [row] = await db.client
        .select()
        .from(containers)
        .where(eq(containers.name, 'somebody-elses'));

      expect((await replace(row.id, { image: 'nginx:1.28' })).body.code).toBe(
        'CONTAINER_NOT_MANAGED',
      );
      expect((await remove(row.id)).body.code).toBe('CONTAINER_NOT_MANAGED');
      expect(dispatched.filter((name) => name === 'container.replace')).toHaveLength(0);
    }, 60_000);

    it('refuses a container that belongs to a Compose project', async () => {
      const { id } = await created();

      const [project] = await db.client
        .insert(composeProjects)
        .values({ hostId, projectName: 'shop', status: 'running', observedAt: new Date() })
        .returning({ id: composeProjects.id });

      await db.client
        .update(containers)
        .set({ composeProjectId: project.id })
        .where(eq(containers.id, id));

      expect((await replace(id, { image: 'nginx:1.28' })).body.code).toBe('MANAGED_BY_STACK');
      expect((await remove(id)).body.code).toBe('MANAGED_BY_STACK');
    }, 60_000);

    it('refuses a container two Docker containers claim', async () => {
      const { id, name } = await created();

      // A second container claiming the same resource, which is what a crash
      // midway through a replacement leaves behind.
      host.seed(`${name}-old`, {
        'io.dockplane.managed': 'true',
        'io.dockplane.container-id': id,
      });

      await discovery.sync(agentId);

      for (const response of [
        await replace(id, { name, image: 'nginx:1.28' }),
        await remove(id),
        await lifecycle('restart', id),
      ]) {
        expect(response.status).toBe(409);
      }

      expect((await replace(id, { name, image: 'nginx:1.28' })).body.code).toBe(
        'CONTAINER_IDENTITY_CONFLICT',
      );
    }, 60_000);

    it('refuses an operator without the permission, and dispatches nothing', async () => {
      const { id, name } = await created();

      session = await signIn('Read Only');
      dispatched = [];

      expect((await create(spec())).status).toBe(403);
      expect((await replace(id, { name, image: 'nginx:1.28' })).status).toBe(403);
      expect((await remove(id)).status).toBe(403);

      expect(dispatched.filter((name) => name.startsWith('container.'))).toEqual([]);
    }, 60_000);

    it('refuses a specification that reaches for the host', async () => {
      for (const body of [
        spec({ mounts: [{ type: 'bind', source: '/var/run/docker.sock', target: '/sock' }] }),
        spec({ mounts: [{ type: 'bind', source: '/etc/shadow', target: '/shadow' }] }),
        spec({ labels: { 'io.dockplane.container-id': 'mine' } }),
        spec({ image: 'nginx:1.27; rm -rf /' }),
        spec({ environment: [{ operation: 'set', key: 'A', value: 'x\nB=y' }] }),
      ]) {
        const response = await create(body);

        expect(response.status).toBe(400);
        // The shape is refused by validation, before anything reads it as a
        // container specification at all.
        expect(response.body.code).toBe('VALIDATION_FAILED');
      }

      expect(dispatched.filter((name) => name === 'container.create')).toHaveLength(0);
    }, 60_000);

    it('refuses a request without the token that proves it was intended', async () => {
      const { id } = await created();

      // A form on another site can make the browser send the session cookie.
      // It cannot read the token, which is why every mutation carries one.
      for (const response of [
        await request(app.getHttpServer())
          .post('/api/v1/containers')
          .set('cookie', session.cookie)
          .set('origin', ORIGIN)
          .send(spec()),
        await request(app.getHttpServer())
          .delete(`/api/v1/containers/${id}`)
          .set('cookie', session.cookie)
          .set('origin', ORIGIN)
          .send({}),
      ]) {
        expect(response.status).toBe(403);
      }

      expect(dispatched.filter((name) => name === 'container.remove')).toHaveLength(0);
    }, 60_000);

    it('refuses a host whose agent is not connected', async () => {
      connection.close();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const response = await create(spec());

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('AGENT_OFFLINE');
      expect(await db.client.select().from(containers)).toHaveLength(0);
    }, 60_000);
  });

  /*
   * Where a secret is allowed to exist.
   *
   * In the request that set it, in the envelope in the database, and in the
   * capability payload for as long as it takes to reach the agent. Nowhere
   * else — and the places it must never reach are the ones that get read by
   * people who were never given the secret.
   */
  /*
   * The rule the whole design rests on.
   *
   * A container change cannot be rolled back by a database, so no transaction
   * is allowed to span one. Held open across a dispatch it would pin a
   * connection to a host that may never answer, and a crash between Docker
   * succeeding and the commit would leave the record disagreeing with the
   * world anyway — the transaction buys nothing and costs a connection.
   *
   * Observed from a second connection of its own, so what it sees is what any
   * other part of the system would see at that moment.
   */
  describe('what the database is doing while a host is working', () => {
    let observer: Database;

    beforeAll(async () => {
      observer = await prepareDatabase();
    });

    afterAll(async () => {
      await observer.onModuleDestroy();
    });

    const openTransactions = async () => {
      /* This test's own application: the database is shared with every other file in the run. */
      const result = await observer.client.execute<{ count: number }>(
        sql`select count(*)::int as count from pg_stat_activity
            where datname = current_database()
              and application_name = current_setting('application_name')
              and state = 'idle in transaction'
              and pid <> pg_backend_pid()`,
      );

      return Number(result.rows[0]?.count ?? 0);
    };

    it('holds no transaction open while the agent is working', async () => {
      const { id, name } = await created();

      holdFor.set('container.replace', 3_000);

      const inFlight = replace(id, { name, image: 'nginx:1.28' }).then((response) => response);

      await new Promise((resolve) => setTimeout(resolve, 800));

      expect(await openTransactions()).toBe(0);

      expect((await inFlight).status).toBe(200);
    }, 180_000);

    it('commits the candidate before the agent is asked for anything', async () => {
      const { id, name } = await created();

      holdFor.set('container.replace', 3_000);

      const inFlight = replace(id, { name, image: 'nginx:1.28' }).then((response) => response);

      await new Promise((resolve) => setTimeout(resolve, 800));

      /*
       * Visible from a connection that had nothing to do with writing it. That
       * is what makes an interrupted change recoverable: the intention is
       * durable before anything can go wrong with carrying it out.
       */
      const candidate = await observer.client
        .select()
        .from(containerDesiredConfigs)
        .where(
          and(
            eq(containerDesiredConfigs.containerId, id),
            eq(containerDesiredConfigs.state, 'pending'),
          ),
        );

      expect(candidate).toHaveLength(1);
      expect(candidate[0].image).toBe('nginx:1.28');
      expect(candidate[0].actionId).not.toBeNull();

      expect((await inFlight).status).toBe(200);
    }, 180_000);

    it('holds none open while reconciling either', async () => {
      const { id, name } = await created();

      // The listing that follows a change is where reconciliation reads the
      // host. A transaction spanning it would wait on the network too.
      holdFor.set('container.list', 2_000);

      const inFlight = replace(id, { name, image: 'nginx:1.28' }).then((response) => response);

      await new Promise((resolve) => setTimeout(resolve, 1_200));

      expect(await openTransactions()).toBe(0);

      expect((await inFlight).status).toBe(200);
    }, 180_000);
  });

  describe('where a secret goes', () => {
    it('is in no record the server keeps', async () => {
      const { id, name } = await created({
        environment: [{ operation: 'set-secret', key: 'DB_PASSWORD', value: CANARY }],
      });

      await replace(id, {
        name,
        image: 'nginx:1.28',
        environment: [{ operation: 'set-secret', key: 'DB_PASSWORD', value: SECOND_CANARY }],
      });

      const rows = [
        ...(await db.client.select().from(actions)),
        ...(await db.client.select().from(auditEntries)),
        ...(await db.client.select().from(containers)),
        ...(await db.client.select().from(containerDesiredConfigs)),
      ];

      const serialised = JSON.stringify(rows);

      expect(serialised).not.toContain(CANARY);
      expect(serialised).not.toContain(SECOND_CANARY);
    }, 60_000);

    it('is not in the configuration the interface reads back', async () => {
      const { id } = await created({
        environment: [
          { operation: 'set', key: 'LOG_LEVEL', value: 'debug' },
          { operation: 'set-secret', key: 'DB_PASSWORD', value: CANARY },
        ],
      });

      const response = await request(app.getHttpServer())
        .get(`/api/v1/containers/${id}/configuration`)
        .set('cookie', session.cookie)
        .set('origin', ORIGIN);

      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(CANARY);

      const environment = response.body.configuration.environment as {
        key: string;
        secret: boolean;
        value?: string;
      }[];

      const secret = environment.find((variable) => variable.key === 'DB_PASSWORD')!;

      // Reported as secret, with no value at all — not even a masked one, whose
      // length would measure the secret.
      expect(secret.secret).toBe(true);
      expect(secret.value).toBeUndefined();
      expect(Object.keys(secret)).toEqual(['key', 'secret']);

      const plain = environment.find((variable) => variable.key === 'LOG_LEVEL')!;

      expect(plain.value).toBe('debug');
    }, 60_000);

    it('is not in what the API returns', async () => {
      const { id } = await created({
        environment: [{ operation: 'set-secret', key: 'DB_PASSWORD', value: CANARY }],
      });

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/containers/${id}`)
        .set('cookie', session.cookie)
        .set('origin', ORIGIN);

      const listing = await request(app.getHttpServer())
        .get('/api/v1/containers')
        .set('cookie', session.cookie)
        .set('origin', ORIGIN);

      expect(JSON.stringify(detail.body)).not.toContain(CANARY);
      expect(JSON.stringify(listing.body)).not.toContain(CANARY);
    }, 60_000);

    it('is not in the error a failed operation produces', async () => {
      host.failWith.set('container.create', {
        code: 'IMAGE_NOT_FOUND',
        message: 'No such image.',
      });

      const response = await create(
        spec({
          image: 'nginx:absent',
          environment: [{ operation: 'set-secret', key: 'DB_PASSWORD', value: CANARY }],
        }),
      );

      expect(JSON.stringify(response.body)).not.toContain(CANARY);

      const recorded = await db.client.select().from(auditEntries);

      expect(JSON.stringify(recorded)).not.toContain(CANARY);
    }, 60_000);
  });
});
