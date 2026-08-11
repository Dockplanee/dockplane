import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { AgentGatewayService } from '../src/agents/agent-gateway.service';
import { Database } from '../src/database/database';
import { DiscoveryService } from '../src/discovery/discovery.service';
import { auditEntries, containers, sessions } from '../src/database/schema';
import { LogStreamService } from '../src/logs/log-stream.service';
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

const SECRET = 'PASSWORD=THIS-MUST-NEVER-BE-STORED';

/** What a scripted agent does when it is asked for a stream. */
interface Script {
  /** Lines to deliver, in batches, before the stream ends. */
  batches?: {
    lines: { stream: string; message: string; timestamp?: string }[];
    dropped?: number;
  }[];
  /** Keep the stream open after the batches instead of ending it. */
  follow?: boolean;
  /** Refuse the request instead of starting a stream. */
  refuse?: { code: string; message: string };
  /** Answer nothing at all, as an agent that lost the request would. */
  silent?: boolean;
}

/**
 * Live container logs over the real gateway.
 *
 * The subject is what crosses the boundaries: what the browser may ask for,
 * what reaches the agent, what comes back, and above all what is written down.
 * A scripted agent stands in for a Docker host so a test can assert that
 * nothing was dispatched as easily as that something was.
 */
describe('container logs', () => {
  let app: INestApplication;
  let db: Database;
  let discovery: DiscoveryService;
  let port: number;
  let caPem: string;

  /** Every capability the agent was asked for, and the payloads it received. */
  let dispatched: { capability: string; payload: Record<string, unknown> }[] = [];
  /** Every message the server sent that was not an ordinary request. */
  let control: string[] = [];

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

  /** An agent that answers discovery normally and streams to a script. */
  const connectScripted = async (
    agent: { certificatePem: string; privateKeyPem: string },
    script: Script,
  ) => {
    const connection = await TestAgentConnection.open({ port, caPem, ...agent });

    connection.send({ type: 'hello', protocolVersion: 1 });
    await connection.waitFor('hello_ack');

    const cancelled = new Set<string>();

    connection.onMessage((message) => {
      if (message.type === 'stream_cancel') {
        control.push('stream_cancel');
        cancelled.add(String(message.streamId));
        return;
      }

      if (message.type !== 'request') {
        return;
      }

      const capability = String(message.capability);

      dispatched.push({
        capability,
        payload: (message.payload ?? {}) as Record<string, unknown>,
      });

      if (capability !== 'container.logs') {
        connection.send({
          type: 'response',
          protocolVersion: 1,
          id: message.id,
          capability,
          status: 'success',
          payload: discoveryPayload(capability),
        });

        return;
      }

      if (script.silent) {
        return;
      }

      if (script.refuse) {
        connection.send({
          type: 'stream_started',
          protocolVersion: 1,
          id: message.id,
          capability,
          streamId: message.streamId,
        });
        connection.send({
          type: 'stream_end',
          protocolVersion: 1,
          id: message.id,
          streamId: message.streamId,
          reason: 'failed',
          error: script.refuse,
        });

        return;
      }

      connection.send({
        type: 'stream_started',
        protocolVersion: 1,
        id: message.id,
        capability,
        streamId: message.streamId,
      });

      let seq = 0;

      for (const batch of script.batches ?? []) {
        connection.send({
          type: 'stream_chunk',
          protocolVersion: 1,
          id: message.id,
          streamId: message.streamId,
          seq: seq++,
          payload: { lines: batch.lines },
          dropped: batch.dropped ?? 0,
        });
      }

      if (!script.follow) {
        connection.send({
          type: 'stream_end',
          protocolVersion: 1,
          id: message.id,
          streamId: message.streamId,
          reason: 'completed',
        });
      }
    });

    return connection;
  };

  const discoveryPayload = (capability: string) => {
    switch (capability) {
      case 'host.inventory':
        return { hostname: 'docker-01', dockerVersion: '29.0.0', observedAt: new Date() };
      case 'host.metrics':
        return { cpuPercent: 5 };
      case 'container.list':
        return {
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
        };
      default:
        return { projects: [] };
    }
  };

  /** Enrols, connects, discovers one container and returns what to read. */
  const ready = async (roleName: string, script: Script) => {
    const admin = await signIn('Administrator');
    const agent = await enrollAgent(admin.cookie, admin.csrf);
    const connection = await connectScripted(agent, script);

    await discovery.sync(agent.agentId);

    const [container] = await db.client.select().from(containers);
    const operator = roleName === 'Administrator' ? admin : await signIn(roleName);

    dispatched = [];
    control = [];

    return { connection, container, agent, operator };
  };

  const readLogs = (containerId: string, session: { cookie: string }, query = '') =>
    request(app.getHttpServer())
      .get(`/api/v1/containers/${containerId}/logs${query}`)
      .set('cookie', session.cookie);

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
    control = [];
  });

  describe('authorization', () => {
    /**
     * A refusal reaches no host.
     *
     * The permission is checked before a container is resolved, before an agent
     * is chosen and before anything is sent, so a request an operator may not
     * make leaves no trace on the machine it was aimed at.
     */
    it('dispatches nothing when the permission is missing', async () => {
      const { connection, container, operator } = await ready('Read Only', {});

      const response = await readLogs(container.id, operator);

      expect(response.status).toBe(403);
      expect(dispatched).toEqual([]);

      connection.close();
    });

    it('refuses an unauthenticated caller without dispatching', async () => {
      const { connection, container } = await ready('Administrator', {});

      const response = await request(app.getHttpServer()).get(
        `/api/v1/containers/${container.id}/logs`,
      );

      expect(response.status).toBe(401);
      expect(dispatched).toEqual([]);

      connection.close();
    });

    /**
     * A refusal is not a sign-out.
     *
     * An operator who may not read logs is still signed in, and everything else
     * they may do keeps working. Anything that ended the session here would put
     * them on the sign-in page, where the original refusal is invisible and the
     * cause looks like an expired session.
     */
    it('leaves the session usable after refusing', async () => {
      const { connection, container, operator } = await ready('Read Only', {});

      expect((await readLogs(container.id, operator)).status).toBe(403);

      const me = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('cookie', operator.cookie);

      expect(me.status).toBe(200);
      expect(me.body.permissions).not.toContain('containers.logs');

      // Another endpoint the operator does hold keeps working.
      await request(app.getHttpServer())
        .get('/api/v1/containers')
        .set('cookie', operator.cookie)
        .expect(200);

      // And the refusal is repeatable rather than escalating to a 401.
      expect((await readLogs(container.id, operator)).status).toBe(403);

      const session = await db.client
        .select({ revokedAt: sessions.revokedAt })
        .from(sessions)
        .where(eq(sessions.userId, operator.user.id));

      expect(session.every((row) => row.revokedAt === null)).toBe(true);

      connection.close();
    });

    it('refuses a stream to an operator without the permission', async () => {
      const { connection, container, operator } = await ready('Read Only', {});

      const response = await request(app.getHttpServer())
        .get(`/api/v1/containers/${container.id}/logs/stream`)
        .set('cookie', operator.cookie);

      expect(response.status).toBe(403);
      expect(dispatched).toEqual([]);

      connection.close();
    });
  });

  describe('validation', () => {
    it('refuses a tail beyond what the product allows', async () => {
      const { connection, container, operator } = await ready('Administrator', {});

      for (const query of ['?tail=5001', '?tail=-1', '?tail=1000000', '?tail=abc']) {
        const response = await readLogs(container.id, operator, query);

        expect(response.status).toBe(400);
      }

      expect(dispatched).toEqual([]);

      connection.close();
    });

    it('refuses a since it cannot understand', async () => {
      const { connection, container, operator } = await ready('Administrator', {});

      for (const query of ['?since=yesterday', '?since=2026-13-45', '?since=1']) {
        expect((await readLogs(container.id, operator, query)).status).toBe(400);
      }

      expect(dispatched).toEqual([]);

      connection.close();
    });

    it('refuses a request for neither output', async () => {
      const { connection, container, operator } = await ready('Administrator', {});

      const response = await readLogs(container.id, operator, '?stdout=false&stderr=false');

      expect(response.status).toBe(400);
      expect(dispatched).toEqual([]);

      connection.close();
    });

    /**
     * The browser names a container and nothing else.
     *
     * Everything the agent acts on — the Docker identifier, the agent, the
     * capability — is derived here. A caller that sends them anyway changes
     * nothing, which is what this asserts rather than assumes.
     */
    it('ignores a Docker identifier, agent or capability sent by the caller', async () => {
      const { connection, container, operator } = await ready('Administrator', {
        batches: [{ lines: [{ stream: 'stdout', message: 'ready' }] }],
      });

      await readLogs(
        container.id,
        operator,
        '?dockerId=bbb999&agentId=someone-else&capability=container.exec&command=sh',
      ).expect(200);

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].capability).toBe('container.logs');
      expect(dispatched[0].payload.containerId).toBe('aaa111');
      expect(Object.keys(dispatched[0].payload).sort()).toEqual([
        'containerId',
        'follow',
        'since',
        'stderr',
        'stdout',
        'tail',
        'timestamps',
      ]);

      connection.close();
    });

    it('answers a container it does not know with a not-found', async () => {
      const { connection, operator } = await ready('Administrator', {});

      const response = await readLogs('11111111-1111-4111-8111-111111111111', operator);

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('CONTAINER_NOT_FOUND');
      expect(dispatched).toEqual([]);

      connection.close();
    });
  });

  describe('snapshot', () => {
    it('returns the lines the host reported', async () => {
      const { connection, container, operator } = await ready('Administrator', {
        batches: [
          {
            lines: [
              { stream: 'stdout', message: 'listening on 8080', timestamp: '2026-08-10T12:00:00Z' },
              { stream: 'stderr', message: 'database unreachable' },
            ],
          },
        ],
      });

      const response = await readLogs(container.id, operator, '?tail=100').expect(200);

      expect(response.body.lines).toHaveLength(2);
      expect(response.body.lines[0]).toMatchObject({
        stream: 'stdout',
        message: 'listening on 8080',
        timestamp: '2026-08-10T12:00:00Z',
      });
      expect(response.body.lines[1].stream).toBe('stderr');

      connection.close();
    });

    it('asks the host for exactly what the caller asked for', async () => {
      const { connection, container, operator } = await ready('Administrator', { batches: [] });

      await readLogs(
        container.id,
        operator,
        '?tail=42&timestamps=false&stdout=true&stderr=false&since=2026-08-10T12:00:00Z',
      ).expect(200);

      expect(dispatched[0].payload).toMatchObject({
        containerId: 'aaa111',
        tail: 42,
        timestamps: false,
        stdout: true,
        stderr: false,
        since: '2026-08-10T12:00:00Z',
        follow: false,
      });

      connection.close();
    });

    it('reports what the host could not deliver', async () => {
      const { connection, container, operator } = await ready('Administrator', {
        batches: [{ lines: [{ stream: 'stdout', message: 'one' }], dropped: 17 }],
      });

      const response = await readLogs(container.id, operator).expect(200);

      expect(response.body.dropped).toBe(17);

      connection.close();
    });

    it('reports a host that refused the read', async () => {
      const { connection, container, operator } = await ready('Administrator', {
        refuse: { code: 'DOCKER_UNAVAILABLE', message: 'the socket is gone' },
      });

      const response = await readLogs(container.id, operator);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('LOG_STREAM_UNAVAILABLE');
      // The host's own wording never becomes the browser's contract.
      expect(JSON.stringify(response.body)).not.toContain('socket is gone');

      connection.close();
    });

    it('reports a host that is not connected', async () => {
      const { connection, container, operator } = await ready('Administrator', {});

      connection.close();
      await new Promise((resolve) => setTimeout(resolve, 200));

      const response = await readLogs(container.id, operator);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('AGENT_OFFLINE');
    });
  });

  describe('streaming', () => {
    /** Reads an event stream until it ends, returning the parsed events. */
    const readStream = (containerId: string, session: { cookie: string }, query = '') =>
      new Promise<{ event: string; data: Record<string, unknown> }[]>((resolve, reject) => {
        const events: { event: string; data: Record<string, unknown> }[] = [];

        request(app.getHttpServer())
          .get(`/api/v1/containers/${containerId}/logs/stream${query}`)
          .set('cookie', session.cookie)
          .buffer(true)
          .parse((response, callback) => {
            let buffer = '';

            response.on('data', (chunk: Buffer) => {
              buffer += chunk.toString('utf8');

              let boundary = buffer.indexOf('\n\n');

              while (boundary !== -1) {
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);

                const event = /^event: (.+)$/m.exec(frame)?.[1];
                const data = /^data: (.+)$/m.exec(frame)?.[1];

                if (event && data) {
                  events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
                }

                boundary = buffer.indexOf('\n\n');
              }
            });

            response.on('end', () => callback(null, events));
          })
          .end((error) => (error ? reject(error) : resolve(events)));
      });

    /**
     * A quiet stream still says something.
     *
     * A container that prints nothing for minutes looks like an idle connection
     * to a reverse proxy, which closes it. The comment keeps the connection
     * open, carries nothing, and is not an event a client could mistake for
     * output.
     */
    it('writes a keepalive comment while a stream is quiet', async () => {
      const { connection, container, operator } = await ready('Administrator', {
        batches: [],
        follow: true,
      });

      const frames = await collectRaw(container.id, operator, 2500);

      expect(frames).toContain(': keepalive');

      // The comment is not an event: it has no `event:` and no `data:` line.
      const comments = frames.split('\n\n').filter((frame) => frame.startsWith(':'));

      expect(comments.length).toBeGreaterThan(0);

      for (const comment of comments) {
        expect(comment).not.toContain('event:');
        expect(comment).not.toContain('data:');
      }

      connection.close();
    });

    it('stops the keepalive when the stream ends', async () => {
      const { connection, container, operator } = await ready('Administrator', {
        batches: [{ lines: [{ stream: 'stdout', message: 'done' }] }],
      });

      // The stream completes at once, well inside one keepalive interval.
      const frames = await collectRaw(container.id, operator, 2500);

      expect(frames).toContain('event: end');
      expect(frames.split(': keepalive').length - 1).toBe(0);

      connection.close();
    });

    /** Reads the raw event-stream text for a while, comments included. */
    const collectRaw = (containerId: string, session: { cookie: string }, forMs: number) =>
      new Promise<string>((resolve, reject) => {
        let text = '';

        const pending = request(app.getHttpServer())
          .get(`/api/v1/containers/${containerId}/logs/stream`)
          .set('cookie', session.cookie)
          .buffer(true)
          .parse((response, callback) => {
            response.on('data', (chunk: Buffer) => {
              text += chunk.toString('utf8');
            });
            response.on('end', () => callback(null, text));
          })
          .end((error) => {
            if (error && !String(error).includes('aborted')) {
              reject(error);
            }
          });

        setTimeout(() => {
          pending.abort();
          resolve(text);
        }, forMs);
      });

    it('opens, delivers and ends', async () => {
      const { connection, container, operator } = await ready('Administrator', {
        batches: [
          { lines: [{ stream: 'stdout', message: 'first' }] },
          { lines: [{ stream: 'stderr', message: 'second' }] },
        ],
      });

      const events = await readStream(container.id, operator);

      expect(events.map((entry) => entry.event)).toEqual(['open', 'lines', 'lines', 'end']);
      expect(events[0].data.streamId).toEqual(expect.any(String));
      expect(events[3].data.reason).toBe('completed');
      expect(dispatched[0].payload.follow).toBe(true);

      connection.close();
    });

    it('tells the browser what the host had to discard', async () => {
      const { connection, container, operator } = await ready('Administrator', {
        batches: [{ lines: [{ stream: 'stdout', message: 'one' }], dropped: 9 }],
      });

      const events = await readStream(container.id, operator);
      const dropped = events.find((entry) => entry.event === 'dropped');

      expect(dropped?.data).toMatchObject({ count: 9, where: 'agent' });

      connection.close();
    });

    /**
     * A browser that goes away takes the stream with it.
     *
     * Nothing else tells the server, so the closed connection has to be what
     * stops the agent — otherwise a closed tab leaves a Docker reader running.
     */
    it('cancels the stream when the browser disconnects', async () => {
      const { connection, container, operator } = await ready('Administrator', {
        batches: [{ lines: [{ stream: 'stdout', message: 'live' }] }],
        follow: true,
      });

      const streams = app.get(LogStreamService);

      const pending = request(app.getHttpServer())
        .get(`/api/v1/containers/${container.id}/logs/stream`)
        .set('cookie', operator.cookie)
        .end(() => undefined);

      await waitFor(() => streams.runningCount === 1);

      pending.abort();

      await waitFor(() => streams.runningCount === 0);
      await waitFor(() => control.includes('stream_cancel'));

      expect(control).toContain('stream_cancel');

      connection.close();
    });

    it('ends the stream when the agent disconnects', async () => {
      const { connection, container, operator } = await ready('Administrator', {
        batches: [{ lines: [{ stream: 'stdout', message: 'live' }] }],
        follow: true,
      });

      const streams = app.get(LogStreamService);
      const events: string[] = [];

      const finished = readStream(container.id, operator).then((entries) => {
        events.push(...entries.map((entry) => entry.event));
        return entries;
      });

      await waitFor(() => streams.runningCount === 1);

      connection.close();

      const entries = await finished;
      const end = entries.find((entry) => entry.event === 'end');

      expect(end?.data.code).toBe('AGENT_OFFLINE');
      expect(streams.runningCount).toBe(0);
    });

    /**
     * A chunk from a replaced connection is never delivered.
     *
     * Stream identifiers are the server's, and a stream is bound to the socket
     * it was opened on. A late chunk from an earlier session must not appear in
     * a stream that belongs to a newer one.
     */
    it('ignores a chunk that does not belong to the stream it names', async () => {
      const { connection, container, operator, agent } = await ready('Administrator', {
        batches: [{ lines: [{ stream: 'stdout', message: 'live' }] }],
        follow: true,
      });

      const streams = app.get(LogStreamService);
      const collected = readStream(container.id, operator);

      await waitFor(() => streams.runningCount === 1);

      // A second connection for the same agent, inventing a chunk for a stream
      // it was never given.
      const impostor = await TestAgentConnection.open({ port, caPem, ...agent });
      impostor.send({ type: 'hello', protocolVersion: 1 });
      await impostor.waitFor('hello_ack');

      impostor.send({
        type: 'stream_chunk',
        protocolVersion: 1,
        id: '11111111-1111-4111-8111-111111111111',
        streamId: '22222222-2222-4222-8222-222222222222',
        seq: 0,
        payload: { lines: [{ stream: 'stdout', message: 'INJECTED' }] },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      impostor.close();
      connection.close();

      const entries = await collected;
      const text = JSON.stringify(entries);

      expect(text).not.toContain('INJECTED');
    });

    it('ends every stream of a revoked agent', async () => {
      const admin = await signIn('Administrator');
      const agent = await enrollAgent(admin.cookie, admin.csrf);
      const connection = await connectScripted(agent, {
        batches: [{ lines: [{ stream: 'stdout', message: 'live' }] }],
        follow: true,
      });

      await discovery.sync(agent.agentId);

      const [container] = await db.client.select().from(containers);
      const streams = app.get(LogStreamService);
      const collected = readStream(container.id, admin);

      await waitFor(() => streams.runningCount === 1);

      await request(app.getHttpServer())
        .post(`/api/v1/agents/${agent.agentId}/revoke`)
        .set('cookie', admin.cookie)
        .set('origin', ORIGIN)
        .set('x-csrf-token', admin.csrf)
        .send({ reason: 'decommissioned' })
        .expect(204);

      const entries = await collected;

      expect(entries.at(-1)?.event).toBe('end');
      expect(streams.runningCount).toBe(0);

      connection.close();
    });

    it('refuses more streams than an operator may hold', async () => {
      const { connection, container, operator } = await ready('Administrator', {
        batches: [],
        follow: true,
      });

      const streams = app.get(LogStreamService);
      const open: request.Test[] = [];

      for (let index = 0; index < 3; index += 1) {
        open.push(
          request(app.getHttpServer())
            .get(`/api/v1/containers/${container.id}/logs/stream`)
            .set('cookie', operator.cookie)
            .end(() => undefined),
        );
      }

      await waitFor(() => streams.runningCount === 3);

      const refused = await readStream(container.id, operator);
      const end = refused.find((entry) => entry.event === 'end');

      expect(end?.data.code).toBe('LOG_STREAM_LIMIT_REACHED');

      open.forEach((pending) => pending.abort());
      await waitFor(() => streams.runningCount === 0);

      connection.close();
    });
  });

  describe('what is written down', () => {
    it('records that a stream ran, and nothing it carried', async () => {
      const { connection, container, operator } = await ready('Administrator', {
        batches: [{ lines: [{ stream: 'stdout', message: SECRET }] }],
      });

      await readLogs(container.id, operator).expect(200);

      const entries = await db.client.select().from(auditEntries);
      const logEntries = entries.filter((entry) => entry.action.startsWith('container.logs'));

      expect(logEntries.map((entry) => entry.action).sort()).toEqual([
        'container.logs.closed',
        'container.logs.opened',
      ]);

      expect(JSON.stringify(entries)).not.toContain(SECRET);

      connection.close();
    });

    /**
     * A log line is never stored.
     *
     * Dockplane cannot know what an application prints, so the only safe place
     * for a line is on its way to the operator who asked for it. This walks the
     * whole database rather than the tables a reviewer would think of.
     */
    it('stores no log content anywhere', async () => {
      const { connection, container, operator } = await ready('Administrator', {
        batches: [{ lines: [{ stream: 'stdout', message: SECRET }] }],
      });

      await readLogs(container.id, operator).expect(200);

      const rows = await db.client.execute(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'public' and data_type in ('text','character varying','jsonb')`,
      );

      for (const row of rows.rows as { table_name: string; column_name: string }[]) {
        const found = await db.client.execute(
          `select 1 from "${row.table_name}" where "${row.column_name}"::text like '%${SECRET}%' limit 1`,
        );

        expect({ table: row.table_name, column: row.column_name, hits: found.rows.length }).toEqual(
          {
            table: row.table_name,
            column: row.column_name,
            hits: 0,
          },
        );
      }

      connection.close();
    });
  });
});

/** Waits for a condition the server reaches on its own. */
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error('the condition was never reached');
}
