import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Server, TLSSocket, createServer } from 'node:tls';

import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Logger } from 'pino';

import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../config/configuration';
import { LOGGER } from '../config/tokens';
import { AgentCaService } from './agent-ca.service';
import { AgentConnectionManager } from './connection-manager.service';
import { AgentDispatchService } from './agent-dispatch.service';
import { DiscoveryScheduler } from '../discovery/discovery.scheduler';
import { EventsService } from '../events/events.service';
import { AgentRegistryService } from './agent-registry.service';
import { CertificateRequestError } from './pki';
import {
  HEARTBEAT_INTERVAL_SECONDS,
  PROTOCOL_VERSION,
  ServerMessage,
  isSupportedProtocolVersion,
  StreamChunkMessage,
  StreamEndMessage,
  StreamStartedMessage,
  parseClientMessage,
} from './protocol';

/** A connection that has not completed its handshake is dropped. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Idle window before a silent connection is closed, based on the heartbeat. */
const IDLE_TIMEOUT_MS = HEARTBEAT_INTERVAL_SECONDS * 3 * 1000;

interface ConnectionState {
  agentId?: string;
  helloReceived: boolean;
  buffer: string;
  bytesBuffered: number;
  /** Set once the gateway has decided to close. Further input is discarded. */
  closing: boolean;
  /** Serialises processing, so messages are handled in the order they arrive. */
  queue: Promise<void>;
}

/**
 * The agent gateway.
 *
 * A separate TLS listener from the browser API, because the two have opposite
 * requirements: agents must present a client certificate, and demanding one
 * from browsers would be unusable.
 *
 * Identity comes from the verified peer certificate and from nothing else. The
 * protocol has no field that names an agent, and if it had one it would be
 * ignored: the fingerprint of the certificate that completed the TLS handshake
 * is looked up in the registry, and that lookup is the identity.
 *
 * There is deliberately no support for a forwarded client-certificate header.
 * Any proxy able to set such a header could impersonate every agent, so mTLS
 * must reach this listener end to end.
 */
@Injectable()
export class AgentGatewayService implements OnModuleInit, OnApplicationShutdown {
  private server?: Server;

  constructor(
    private readonly registry: AgentRegistryService,
    private readonly connections: AgentConnectionManager,
    private readonly dispatch: AgentDispatchService,
    private readonly discovery: DiscoveryScheduler,
    private readonly events: EventsService,
    private readonly ca: AgentCaService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    const cleared = await this.registry.resetConnectionState();

    if (cleared > 0) {
      this.logger.info(
        { event: 'agent_connection_state_reset', agents: cleared },
        'cleared connection state left by a previous process',
      );
    }

    await this.listen();
  }

  async onApplicationShutdown(): Promise<void> {
    this.connections.closeAll();

    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => resolve());
    });
  }

  /** Bound port, which differs from the configured one when a test binds to 0. */
  get port(): number {
    const address = this.server?.address();

    return typeof address === 'object' && address ? address.port : this.config.AGENT_GATEWAY_PORT;
  }

  private async listen(): Promise<void> {
    const options = {
      cert: readFileSync(this.config.AGENT_GATEWAY_TLS_CERT_PATH),
      key: readFileSync(this.config.AGENT_GATEWAY_TLS_KEY_PATH),
      ca: readFileSync(this.config.AGENT_CLIENT_CA_CERT_PATH),
      /*
       * Both flags are required. `requestCert` alone would ask for a
       * certificate and continue without one; `rejectUnauthorized` is what
       * makes an untrusted or absent certificate fail the handshake.
       */
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2' as const,
      honorCipherOrder: true,
    };

    this.server = createServer(options, (socket) => this.onConnection(socket));

    /*
     * A failed handshake is expected background noise on a public listener —
     * scanners, probes, an agent with a revoked certificate retrying. It is
     * logged at debug so it cannot be used to flood the log.
     */
    this.server.on('tlsClientError', (error) => {
      this.logger.debug(
        { event: 'agent_tls_error', reason: error.message },
        'TLS handshake failed',
      );
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.AGENT_GATEWAY_PORT, this.config.AGENT_GATEWAY_HOST, () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });

    this.logger.info(
      { event: 'agent_gateway_started', port: this.port, host: this.config.AGENT_GATEWAY_HOST },
      'agent gateway listening',
    );
  }

  private onConnection(socket: TLSSocket): void {
    const state: ConnectionState = {
      helloReceived: false,
      buffer: '',
      bytesBuffered: 0,
      closing: false,
      queue: Promise.resolve(),
    };

    socket.setTimeout(HANDSHAKE_TIMEOUT_MS);
    socket.on('timeout', () => socket.destroy());

    /*
     * Handling a message involves database work, so a chunk can arrive while
     * the previous one is still being processed. Chaining makes the order
     * deterministic rather than dependent on how the two happen to interleave:
     * an agent that pipelines hello and heartbeat must never have the heartbeat
     * overtake the hello it depends on.
     */
    socket.on('data', (chunk: Buffer) => {
      state.queue = state.queue.then(() =>
        this.onData(socket, state, chunk).catch((error: unknown) => {
          this.logger.error(
            { event: 'agent_message_failed', agentId: state.agentId, error },
            'failed to handle an agent message',
          );
          socket.destroy();
        }),
      );
    });

    socket.on('error', () => socket.destroy());

    socket.on('close', () => {
      // Anything still waiting on this connection can never be answered on it.
      this.dispatch.abandon(socket);

      if (state.agentId && this.connections.release(state.agentId, socket)) {
        const agentId = state.agentId;

        this.discovery.stop(agentId);

        /*
         * A close handler cannot wait, so both writes run detached — and a
         * detached rejection would otherwise be an unhandled one, which ends
         * the process. An agent disconnecting is the most ordinary event there
         * is; it must not be able to take the control server down with it.
         */
        void this.recordDisconnect(agentId);
      }
    });
  }

  /** Records a disconnect, reporting a failure instead of raising it. */
  private async recordDisconnect(agentId: string): Promise<void> {
    try {
      await this.registry.markDisconnected(agentId);
      await this.events.record({
        type: 'agent.disconnected',
        resource: `agent:${agentId}`,
        message: 'The agent disconnected.',
      });
    } catch (error) {
      this.logger.warn(
        {
          event: 'agent_disconnect_not_recorded',
          agentId,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'could not record an agent disconnect',
      );
    }
  }

  private async onData(socket: TLSSocket, state: ConnectionState, chunk: Buffer): Promise<void> {
    /*
     * A peer whose message was refused often has more of it already in flight.
     * That remainder is dropped rather than parsed, and above all is never
     * answered again: writing to a socket that is already ending would fail and
     * tear the connection down before the refusal has been flushed to the agent.
     */
    if (state.closing) {
      return;
    }

    state.bytesBuffered += chunk.length;

    // A peer that never sends a delimiter must not be able to grow the buffer
    // without bound.
    if (state.bytesBuffered > this.config.AGENT_MAX_MESSAGE_BYTES) {
      this.fail(
        socket,
        state,
        'AGENT_MESSAGE_TOO_LARGE',
        'The message exceeds the permitted size.',
      );
      state.buffer = '';
      state.bytesBuffered = 0;
      return;
    }

    state.buffer += chunk.toString('utf8');

    let newline = state.buffer.indexOf('\n');

    while (newline !== -1) {
      const line = state.buffer.slice(0, newline).trim();
      state.buffer = state.buffer.slice(newline + 1);
      state.bytesBuffered = Buffer.byteLength(state.buffer, 'utf8');

      if (line) {
        await this.onMessage(socket, state, line);

        if (state.closing || socket.destroyed) {
          return;
        }
      }

      newline = state.buffer.indexOf('\n');
    }
  }

  private async onMessage(socket: TLSSocket, state: ConnectionState, line: string): Promise<void> {
    const message = parseClientMessage(line);

    if (!message) {
      this.fail(
        socket,
        state,
        'AGENT_PROTOCOL_UNSUPPORTED',
        'The message could not be understood.',
      );
      return;
    }

    if (!isSupportedProtocolVersion(message.protocolVersion)) {
      this.fail(
        socket,
        state,
        'AGENT_PROTOCOL_UNSUPPORTED',
        `Protocol version ${message.protocolVersion} is not supported.`,
      );
      return;
    }

    const identity = await this.resolveIdentity(socket, state);

    if (!identity) {
      return;
    }

    // A message must never be attributed to a different agent than the one that
    // completed the handshake.
    if (state.agentId && state.agentId !== identity.id) {
      this.fail(socket, state, 'AGENT_IDENTITY_MISMATCH', 'The connection identity changed.');
      return;
    }

    switch (message.type) {
      case 'hello':
        await this.onHello(socket, state, identity.id, message.agentVersion, message.capabilities);
        return;

      case 'heartbeat':
        if (!state.helloReceived) {
          this.fail(
            socket,
            state,
            'AGENT_PROTOCOL_UNSUPPORTED',
            'Send hello before any other message.',
          );
          return;
        }

        await this.registry.touch(identity.id);
        this.send(socket, { type: 'heartbeat_ack', protocolVersion: PROTOCOL_VERSION });
        return;

      case 'certificate.renew':
        if (!state.helloReceived) {
          this.fail(
            socket,
            state,
            'AGENT_PROTOCOL_UNSUPPORTED',
            'Send hello before any other message.',
          );
          return;
        }

        await this.onRenewal(socket, state, identity.id, message.csr);
        return;

      case 'response':
        if (!state.helloReceived) {
          this.fail(
            socket,
            state,
            'AGENT_PROTOCOL_UNSUPPORTED',
            'Send hello before any other message.',
          );
          return;
        }

        /*
         * A reply the server cannot account for is a protocol violation, not a
         * harmless extra: it is either a duplicate, an answer to a request that
         * already timed out, or one the agent invented.
         */
        if (!this.dispatch.settle(socket, message)) {
          this.fail(
            socket,
            state,
            'AGENT_RESPONSE_INVALID',
            'The reply does not match an outstanding request.',
          );
        }

        return;

      case 'stream_started':
      case 'stream_chunk':
      case 'stream_end':
        if (!state.helloReceived) {
          this.fail(
            socket,
            state,
            'AGENT_PROTOCOL_UNSUPPORTED',
            'Send hello before any other message.',
          );
          return;
        }

        this.onStreamMessage(socket, message);
        return;
    }
  }

  /**
   * Routes one message of a running stream.
   *
   * A message that cannot be placed is dropped rather than treated as a
   * protocol violation. Unlike a reply, a stream message can legitimately
   * arrive late: the server may have cancelled the stream a moment ago, and
   * the chunks already on the wire are simply no longer wanted. Closing the
   * connection over one would take every other stream down with it.
   */
  private onStreamMessage(
    socket: TLSSocket,
    message: StreamStartedMessage | StreamChunkMessage | StreamEndMessage,
  ): void {
    const accepted =
      message.type === 'stream_started'
        ? this.dispatch.acceptStreamStart(socket, message)
        : message.type === 'stream_chunk'
          ? this.dispatch.acceptStreamChunk(socket, message)
          : this.dispatch.acceptStreamEnd(socket, message);

    if (!accepted) {
      this.logger.debug(
        { event: 'agent_stream_message_ignored', type: message.type, streamId: message.streamId },
        'a stream message did not belong to a running stream',
      );
    }
  }

  /**
   * Derives the agent from the peer certificate on every message.
   *
   * Re-checking rather than trusting the handshake once means a revocation that
   * lands mid-connection stops the very next message, without needing to reach
   * into the socket from elsewhere.
   */
  private async resolveIdentity(
    socket: TLSSocket,
    state: ConnectionState,
  ): Promise<{ id: string } | undefined> {
    const peer = socket.getPeerCertificate();

    if (!peer || !peer.raw) {
      this.fail(socket, state, 'AGENT_CERT_INVALID', 'A client certificate is required.');
      return undefined;
    }

    const fingerprint = createHash('sha256').update(peer.raw).digest('hex');
    const agent = await this.registry.findByFingerprint(fingerprint);

    if (!agent) {
      this.fail(socket, state, 'AGENT_UNKNOWN', 'The certificate is not associated with an agent.');
      return undefined;
    }

    if (agent.revokedAt) {
      this.fail(socket, state, 'AGENT_REVOKED', 'The agent credential has been revoked.');
      return undefined;
    }

    if (agent.certificateNotAfter.getTime() <= Date.now()) {
      this.fail(socket, state, 'AGENT_CERT_EXPIRED', 'The agent certificate has expired.');
      return undefined;
    }

    return { id: agent.id };
  }

  private async onHello(
    socket: TLSSocket,
    state: ConnectionState,
    agentId: string,
    agentVersion?: string,
    capabilities: readonly string[] = [],
  ): Promise<void> {
    state.agentId = agentId;
    state.helloReceived = true;

    this.connections.register(agentId, socket);
    await this.registry.markConnected(agentId, agentVersion, capabilities);

    socket.setTimeout(IDLE_TIMEOUT_MS);

    const agent = await this.registry.findById(agentId);
    const notAfter = agent?.certificateNotAfter ?? new Date();

    this.send(socket, {
      type: 'hello_ack',
      protocolVersion: PROTOCOL_VERSION,
      // From the registry, never from anything the agent sent.
      agentId,
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
      certificateNotAfter: notAfter.toISOString(),
      renewAfter: this.renewAfter(notAfter),
    });

    // Discovery starts only after the handshake, so a connection that never
    // identified itself is never polled.
    this.discovery.start(agentId);

    await this.events.record({
      hostId: agent?.hostId,
      type: 'agent.connected',
      resource: `agent:${agentId}`,
      message: 'The agent connected.',
    });

    this.logger.info({ event: 'agent_connected', agentId }, 'agent connected');
  }

  /**
   * Issues a replacement certificate over the authenticated connection.
   *
   * Renewal deliberately has no token: the proof of identity is the current
   * certificate that authenticated this very connection. The identity is
   * carried over unchanged, so an agent cannot become another agent by renewing.
   */
  private async onRenewal(
    socket: TLSSocket,
    state: ConnectionState,
    agentId: string,
    csrPem: string,
  ): Promise<void> {
    let certificate;

    try {
      certificate = await this.ca.issueAgentCertificate(csrPem, agentId);
    } catch (error) {
      this.fail(
        socket,
        state,
        'ENROLLMENT_CSR_INVALID',
        error instanceof CertificateRequestError
          ? error.message
          : 'The certificate request was not accepted.',
        false,
      );
      return;
    }

    await this.registry.replaceCertificate(agentId, certificate);

    await this.audit.record({
      action: 'agent.certificate.renewed',
      result: 'success',
      actorLabel: 'agent-gateway',
      targetType: 'agent',
      targetId: agentId,
      reasonCode: certificate.serialHex,
    });

    this.send(socket, {
      type: 'certificate.renewed',
      protocolVersion: PROTOCOL_VERSION,
      certificate: certificate.certificatePem,
      certificateNotAfter: certificate.notAfter.toISOString(),
      renewAfter: this.renewAfter(certificate.notAfter),
    });

    this.logger.info({ event: 'agent_certificate_renewed', agentId }, 'agent certificate renewed');
  }

  /**
   * The instant an agent should begin renewing.
   *
   * The renewal window is a deployment policy, so the server states it rather
   * than leaving every agent to decide when its certificate is old enough.
   */
  private renewAfter(notAfter: Date): string {
    return new Date(notAfter.getTime() - this.config.AGENT_CERT_RENEW_BEFORE * 1000).toISOString();
  }

  private send(socket: TLSSocket, message: ServerMessage): void {
    if (!socket.destroyed) {
      socket.write(`${JSON.stringify(message)}\n`);
    }
  }

  /**
   * Refuses a message.
   *
   * end() rather than destroy(), so the refusal is flushed to the agent instead
   * of being discarded with the write buffer. The connection is marked closing
   * at the same time, because anything still in flight from the peer must not
   * produce a second write onto a socket that is already ending.
   */
  private fail(
    socket: TLSSocket,
    state: ConnectionState,
    code: string,
    message: string,
    close = true,
  ): void {
    if (state.closing) {
      return;
    }

    this.send(socket, { type: 'error', protocolVersion: PROTOCOL_VERSION, code, message });

    if (close) {
      state.closing = true;
      socket.end();
    }
  }
}
