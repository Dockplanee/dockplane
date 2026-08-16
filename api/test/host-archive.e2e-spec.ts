import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { AgentConnectionManager } from '../src/agents/connection-manager.service';
import { Database } from '../src/database/database';
import { agents, auditEntries, composeProjects, containers, hosts } from '../src/database/schema';
import { DEFAULT_PASSWORD, createTestApp, resetData, resetThrottling, seedUser } from './app';

const ORIGIN = 'http://localhost:4200';

/*
Archiving a host, and everything that must go on being true afterwards.

Archiving takes an identity out of the working set. It deletes nothing, merges
nothing and decides nothing about which host is "really" a machine: two
enrolments of one server stay two hosts, and archiving one of them is how an
operator says which is current.
*/
describe('host archival', () => {
  let app: INestApplication;
  let db: Database;
  let connections: AgentConnectionManager;

  const signIn = async (email: string) => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('origin', ORIGIN)
      .send({ email, password: DEFAULT_PASSWORD });

    const raw = response.headers['set-cookie'] as unknown as string[];

    return {
      cookie: raw.find((entry) => entry.startsWith('dockplane_session='))!.split(';')[0],
      csrf: response.body.csrfToken as string,
    };
  };

  const seedHost = async (hostname: string, displayName?: string) => {
    const [host] = await db.client
      .insert(hosts)
      .values({ hostname, displayName })
      .returning({ id: hosts.id });

    return host.id;
  };

  const seedAgent = async (hostId: string, options: { revoked?: boolean } = {}) => {
    const [agent] = await db.client
      .insert(agents)
      .values({
        hostId,
        certificateFingerprint: `fp-${Math.random().toString(36).slice(2)}`,
        certificateSerial: `serial-${Math.random().toString(36).slice(2)}`,
        certificateNotAfter: new Date(Date.now() + 86_400_000),
        protocolVersion: 1,
        status: options.revoked ? 'revoked' : 'disconnected',
        revokedAt: options.revoked ? new Date() : null,
      })
      .returning({ id: agents.id });

    return agent.id;
  };

  let workspace: string;

  beforeAll(async () => {
    /*
     * Saving a stack compiles its Compose file, so the real compiler has to be
     * here for the tests that prove an offline host can still be prepared for.
     */
    workspace = mkdtempSync(join(tmpdir(), 'dockplane-archive-'));

    execFileSync('go', ['build', '-o', join(workspace, 'compose-compiler'), '.'], {
      cwd: join(__dirname, '..', '..', 'compose-compiler'),
      stdio: 'pipe',
    });

    process.env.DOCKPLANE_COMPOSE_COMPILER = join(workspace, 'compose-compiler');

    app = await createTestApp();
    db = app.get(Database);
    connections = app.get(AgentConnectionManager);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DOCKPLANE_COMPOSE_COMPILER;
    rmSync(workspace, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetData(db);
    resetThrottling(app);
  });

  /*
   * The migration is additive and infers nothing. A host that was offline, or
   * whose agent was revoked, or that shares a hostname with five others, is
   * still active until somebody archives it.
   */
  describe('the schema this build ships', () => {
    it('carries the column, nullable', async () => {
      const result = await db.client.execute<{ is_nullable: string; data_type: string }>(
        sql`select is_nullable, data_type from information_schema.columns
            where table_name = 'hosts' and column_name = 'archived_at'`,
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].is_nullable).toBe('YES');
      expect(result.rows[0].data_type).toBe('timestamp with time zone');
    });

    it('leaves every existing host active', async () => {
      await seedHost('docker-01');
      await seedHost('docker-01');
      const revoked = await seedHost('retired-01');
      await seedAgent(revoked, { revoked: true });

      const rows = await db.client.select({ archivedAt: hosts.archivedAt }).from(hosts);

      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.archivedAt === null)).toBe(true);
    });
  });

  describe('archiving', () => {
    it('takes a disconnected host out of the working set', async () => {
      const hostId = await seedHost('retired-01', 'Retired 01');
      await seedAgent(hostId);

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      const session = await signIn(user.email);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/hosts/${hostId}/archive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(200);

      expect(response.body.host.archived).toBe(true);
      expect(response.body.host.archivedAt).toEqual(expect.any(String));
    });

    it('archives a host whose agent was revoked, and leaves the agent alone', async () => {
      const hostId = await seedHost('revoked-01');
      const agentId = await seedAgent(hostId, { revoked: true });

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      const session = await signIn(user.email);

      await request(app.getHttpServer())
        .post(`/api/v1/hosts/${hostId}/archive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(200);

      const [agent] = await db.client.select().from(agents).where(eq(agents.id, agentId));

      // Archiving is a lifecycle decision, never a security one.
      expect(agent).toBeDefined();
      expect(agent.status).toBe('revoked');
      expect(agent.certificateFingerprint).toEqual(expect.any(String));
    });

    /*
     * The product decision this feature rests on: archiving is for identities
     * that are finished, and a host whose agent is answering is not one.
     */
    it('refuses a host whose agent is connected', async () => {
      const hostId = await seedHost('busy-01');
      const agentId = await seedAgent(hostId);

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      const session = await signIn(user.email);

      jest.spyOn(connections, 'isConnected').mockImplementation((id) => id === agentId);

      try {
        const response = await request(app.getHttpServer())
          .post(`/api/v1/hosts/${hostId}/archive`)
          .set('cookie', session.cookie)
          .set('x-csrf-token', session.csrf)
          .set('origin', ORIGIN)
          .expect(409);

        expect(response.body.code).toBe('HOST_CONNECTED');
      } finally {
        jest.restoreAllMocks();
      }

      const [host] = await db.client.select().from(hosts).where(eq(hosts.id, hostId));
      expect(host.archivedAt).toBeNull();
    });

    /*
     * The browser cannot decide this. An agent can reconnect between the page
     * rendering and the request arriving, so the state that decides is the one
     * at the moment of the mutation.
     */
    it('refuses a host that reconnected after the page was rendered', async () => {
      const hostId = await seedHost('reconnecting-01');
      const agentId = await seedAgent(hostId);

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      const session = await signIn(user.email);

      // What the browser saw: nothing connected.
      const listed = await request(app.getHttpServer())
        .get('/api/v1/hosts')
        .set('cookie', session.cookie)
        .expect(200);

      expect(listed.body.hosts.some((host: { id: string }) => host.id === hostId)).toBe(true);

      // And then it reconnected.
      jest.spyOn(connections, 'isConnected').mockImplementation((id) => id === agentId);

      try {
        await request(app.getHttpServer())
          .post(`/api/v1/hosts/${hostId}/archive`)
          .set('cookie', session.cookie)
          .set('x-csrf-token', session.csrf)
          .set('origin', ORIGIN)
          .expect(409);
      } finally {
        jest.restoreAllMocks();
      }
    });

    it('is unchanged by archiving a host that is already archived', async () => {
      const hostId = await seedHost('retired-01');

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      const session = await signIn(user.email);

      const first = await request(app.getHttpServer())
        .post(`/api/v1/hosts/${hostId}/archive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(200);

      const second = await request(app.getHttpServer())
        .post(`/api/v1/hosts/${hostId}/archive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(200);

      expect(second.body.host.archivedAt).toBe(first.body.host.archivedAt);

      // One decision, one entry.
      const trail = await db.client
        .select()
        .from(auditEntries)
        .where(eq(auditEntries.action, 'host.archived'));

      expect(trail).toHaveLength(1);
    });

    it('refuses a caller without the permission', async () => {
      const hostId = await seedHost('retired-01');

      const user = await seedUser(db, { email: 'operator@example.internal', roleName: 'Operator' });
      const session = await signIn(user.email);

      await request(app.getHttpServer())
        .post(`/api/v1/hosts/${hostId}/archive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(403);

      const [host] = await db.client.select().from(hosts).where(eq(hosts.id, hostId));
      expect(host.archivedAt).toBeNull();
    });

    it('refuses an unauthenticated caller', async () => {
      const hostId = await seedHost('retired-01');

      await request(app.getHttpServer()).post(`/api/v1/hosts/${hostId}/archive`).expect(401);
    });

    /* The identifier, because a hostname names a machine and not a host row. */
    it('records who did it and to which identity', async () => {
      const hostId = await seedHost('shared-01', 'Retired enrolment');

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      const session = await signIn(user.email);

      await request(app.getHttpServer())
        .post(`/api/v1/hosts/${hostId}/archive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(200);

      const [entry] = await db.client
        .select()
        .from(auditEntries)
        .where(eq(auditEntries.action, 'host.archived'));

      expect(entry.actorUserId).toBe(user.id);
      expect(entry.actorLabel).toBe(user.email);
      expect(entry.targetType).toBe('host');
      expect(entry.targetId).toBe(hostId);
      expect(entry.result).toBe('success');
    });
  });

  describe('restoring', () => {
    const archive = async (hostId: string, session: { cookie: string; csrf: string }) =>
      request(app.getHttpServer())
        .post(`/api/v1/hosts/${hostId}/archive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(200);

    it('puts a host back into the working set', async () => {
      const hostId = await seedHost('returning-01');

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      const session = await signIn(user.email);

      await archive(hostId, session);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/hosts/${hostId}/unarchive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(200);

      expect(response.body.host.archived).toBe(false);
      expect(response.body.host.archivedAt).toBeNull();

      const [entry] = await db.client
        .select()
        .from(auditEntries)
        .where(eq(auditEntries.action, 'host.unarchived'));

      expect(entry.targetId).toBe(hostId);
    });

    it('is unchanged by restoring a host that is already active', async () => {
      const hostId = await seedHost('active-01');

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      const session = await signIn(user.email);

      await request(app.getHttpServer())
        .post(`/api/v1/hosts/${hostId}/unarchive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(200);

      const trail = await db.client
        .select()
        .from(auditEntries)
        .where(eq(auditEntries.action, 'host.unarchived'));

      expect(trail).toHaveLength(0);
    });

    it('refuses a caller without the permission', async () => {
      const hostId = await seedHost('returning-01');

      const admin = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      await archive(hostId, await signIn(admin.email));

      const operator = await seedUser(db, {
        email: 'operator@example.internal',
        roleName: 'Operator',
      });
      const session = await signIn(operator.email);

      await request(app.getHttpServer())
        .post(`/api/v1/hosts/${hostId}/unarchive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(403);
    });
  });

  describe('what the lists show', () => {
    let active: string;
    let archived: string;
    let session: { cookie: string; csrf: string };

    beforeEach(async () => {
      active = await seedHost('shared-hostname', 'Current enrolment');
      archived = await seedHost('shared-hostname', 'Superseded enrolment');

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      session = await signIn(user.email);

      await request(app.getHttpServer())
        .post(`/api/v1/hosts/${archived}/archive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(200);
    });

    const list = async (scope?: string) => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/hosts${scope ? `?scope=${scope}` : ''}`)
        .set('cookie', session.cookie)
        .expect(200);

      return response.body;
    };

    it('shows only the active hosts by default', async () => {
      const body = await list();

      expect(body.scope).toBe('active');
      expect(body.hosts.map((host: { id: string }) => host.id)).toEqual([active]);
      expect(body.page.total).toBe(1);
    });

    it('shows the archived ones when asked', async () => {
      const body = await list('archived');

      expect(body.hosts.map((host: { id: string }) => host.id)).toEqual([archived]);
      expect(body.hosts[0].archived).toBe(true);
    });

    it('shows both when asked for all', async () => {
      const body = await list('all');

      expect(body.hosts).toHaveLength(2);
    });

    /*
     * The lesson the six-identity fixture exists to hold: archiving one
     * enrolment of a machine says nothing about the others, and does not merge
     * them.
     */
    it('keeps two identities that share a hostname apart', async () => {
      const body = await list('all');
      const ids = body.hosts.map((host: { id: string }) => host.id).sort();

      expect(ids).toEqual([active, archived].sort());
      expect(new Set(body.hosts.map((host: { hostname: string }) => host.hostname)).size).toBe(1);
    });

    it('reads an archived host directly rather than reporting it missing', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/hosts/${archived}`)
        .set('cookie', session.cookie)
        .expect(200);

      expect(response.body.host.id).toBe(archived);
      expect(response.body.host.archived).toBe(true);
      expect(response.body.host.hostname).toBe('shared-hostname');
    });
  });

  /*
   * Nothing historical may disappear because a host left the working set. This
   * is the failure mode a filter placed in the wrong query produces, and it is
   * silent: the rows are simply not there.
   */
  describe('what history goes on saying', () => {
    it('keeps a container on an archived host visible, with its host identity', async () => {
      const hostId = await seedHost('retired-01', 'Retired 01');

      await db.client.insert(containers).values({
        hostId,
        dockerId: 'aaaaaaaaaaaa',
        name: 'legacy-web',
        image: 'nginx:1.27',
        state: 'running',
        observedAt: new Date(),
      });

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      const session = await signIn(user.email);

      await request(app.getHttpServer())
        .post(`/api/v1/hosts/${hostId}/archive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(200);

      const response = await request(app.getHttpServer())
        .get('/api/v1/containers')
        .set('cookie', session.cookie)
        .expect(200);

      const container = response.body.containers.find(
        (row: { name: string }) => row.name === 'legacy-web',
      );

      expect(container).toBeDefined();
      expect(container.hostId).toBe(hostId);
      expect(container.hostname).toBe('retired-01');
    });

    it('keeps a Compose project on an archived host attributed to it', async () => {
      const hostId = await seedHost('retired-02');

      await db.client.insert(composeProjects).values({
        hostId,
        projectName: 'legacy-stack',
        workingDir: '/srv/legacy',
        observedAt: new Date(),
      });

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      const session = await signIn(user.email);

      await request(app.getHttpServer())
        .post(`/api/v1/hosts/${hostId}/archive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(200);

      const response = await request(app.getHttpServer())
        .get('/api/v1/compose-projects')
        .set('cookie', session.cookie)
        .expect(200);

      const project = response.body.projects.find(
        (row: { projectName: string }) => row.projectName === 'legacy-stack',
      );

      expect(project).toBeDefined();
      expect(project.hostId).toBe(hostId);
      expect(project.hostname).toBe('retired-02');
    });

    /*
     * Two enrolments of one machine can each carry a container with the same
     * Docker identifier. They are two records and stay two records; archiving
     * one host must not fold them together.
     */
    it('keeps the same Docker identifier on two identities apart', async () => {
      const older = await seedHost('shared-hostname', 'Older enrolment');
      const newer = await seedHost('shared-hostname', 'Newer enrolment');

      for (const hostId of [older, newer]) {
        await db.client.insert(containers).values({
          hostId,
          dockerId: 'cccccccccccc',
          name: 'api',
          image: 'nginx:1.27',
          state: 'running',
          observedAt: new Date(),
        });
      }

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      const session = await signIn(user.email);

      await request(app.getHttpServer())
        .post(`/api/v1/hosts/${older}/archive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(200);

      const response = await request(app.getHttpServer())
        .get('/api/v1/containers')
        .set('cookie', session.cookie)
        .expect(200);

      const matching = response.body.containers.filter(
        (row: { dockerId: string }) => row.dockerId === 'cccccccccccc',
      );

      expect(matching).toHaveLength(2);
      expect(new Set(matching.map((row: { hostId: string }) => row.hostId))).toEqual(
        new Set([older, newer]),
      );
    });
  });


  /*
   * What an archived host is no longer a target for.
   *
   * Reads are untouched throughout — the point of archiving is to withdraw the
   * host as somewhere to do new work, not to hide what it did.
   */
  describe('operations against an archived host', () => {
    let hostId: string;
    let session: { cookie: string; csrf: string };

    const COMPOSE = ['services:', '  web:', '    image: nginx:1.27'].join('\n');

    beforeEach(async () => {
      hostId = await seedHost('retired-01', 'Retired 01');
      await seedAgent(hostId);

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      session = await signIn(user.email);
    });

    const archive = async () =>
      request(app.getHttpServer())
        .post(`/api/v1/hosts/${hostId}/archive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(200);

    const post = (path: string, body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post(path)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .send(body);

    it('refuses a container create', async () => {
      await archive();

      const response = await post('/api/v1/containers', {
        hostId,
        name: 'new-web',
        image: 'nginx:1.27',
      });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('HOST_ARCHIVED');
    });

    it('refuses a stack create', async () => {
      await archive();

      const response = await post('/api/v1/stacks', {
        name: `shop-${Date.now().toString(36)}`,
        hostId,
        compose: COMPOSE,
      });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('HOST_ARCHIVED');
    });

    /*
     * Archived is not offline. Saving a stack for a machine that is currently
     * offline has been allowed since 0.2 and is a reasonable thing to do; that
     * behaviour must survive this feature untouched.
     */
    it('still lets a stack be saved for an offline host that is active', async () => {
      const response = await post('/api/v1/stacks', {
        name: `shop-${Date.now().toString(36)}`,
        hostId,
        compose: COMPOSE,
      });

      expect(response.status).toBe(201);
      expect(response.body.stackId).toEqual(expect.any(String));
      expect(response.body.revisionNumber).toBe(1);
    });

    it('keeps a stack saved before archiving readable afterwards', async () => {
      const created = await post('/api/v1/stacks', {
        name: `shop-${Date.now().toString(36)}`,
        hostId,
        compose: COMPOSE,
      });

      expect(created.status).toBe(201);
      const stackId = created.body.stackId ?? created.body.id;

      await archive();

      const read = await request(app.getHttpServer())
        .get(`/api/v1/stacks/${stackId}`)
        .set('cookie', session.cookie)
        .expect(200);

      expect(read.body.stack.id).toBe(stackId);
      expect(read.body.stack.hostId).toBe(hostId);
      expect(read.body.stack.hostname).toBe('retired-01');
    });

    it('lets everything be done again once the host is restored', async () => {
      await archive();

      await request(app.getHttpServer())
        .post(`/api/v1/hosts/${hostId}/unarchive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(200);

      const response = await post('/api/v1/stacks', {
        name: `shop-${Date.now().toString(36)}`,
        hostId,
        compose: COMPOSE,
      });

      expect(response.status).toBe(201);
    });
  });

  /*
   * An archived host that starts reporting again keeps its state. A heartbeat
   * is not a decision, and a decision is what put it there.
   */
  describe('when an archived host reports again', () => {
    it('does not clear the archive state', async () => {
      const hostId = await seedHost('returning-01');

      const user = await seedUser(db, {
        email: 'admin@example.internal',
        roleName: 'Administrator',
      });
      const session = await signIn(user.email);

      await request(app.getHttpServer())
        .post(`/api/v1/hosts/${hostId}/archive`)
        .set('cookie', session.cookie)
        .set('x-csrf-token', session.csrf)
        .set('origin', ORIGIN)
        .expect(200);

      const [before] = await db.client.select().from(hosts).where(eq(hosts.id, hostId));

      // What discovery writes when a host reports: everything except this.
      await db.client
        .update(hosts)
        .set({
          hostname: 'returning-01',
          os: 'Debian GNU/Linux 13',
          dockerVersion: '29.0.0',
          observedAt: new Date(),
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(hosts.id, hostId));

      const [after] = await db.client.select().from(hosts).where(eq(hosts.id, hostId));

      expect(after.archivedAt).toEqual(before.archivedAt);
      expect(after.dockerVersion).toBe('29.0.0');
    });
  });
});
