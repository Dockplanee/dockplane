import { randomUUID } from 'node:crypto';
import { TLSSocket } from 'node:tls';

import { Inject, Injectable } from '@nestjs/common';
import { Logger } from 'pino';

import { AppError, ErrorCode } from '../common/errors';
import { LOGGER } from '../config/tokens';
import {
  CAPABILITY_TIMEOUT_MS,
  Capability,
  StreamingCapability,
  agentErrorCode,
  agentErrorMessage,
  isCapability,
  isStreaming,
} from './capabilities';
import { AgentConnectionManager } from './connection-manager.service';
import {
  CapabilityRequestMessage,
  CapabilityResponseMessage,
  PROTOCOL_VERSION,
  StreamCancelMessage,
  StreamChunkMessage,
  StreamEndMessage,
  StreamStartedMessage,
} from './protocol';

/** What a caller is told about a stream while it runs. */
export interface StreamObserver {
  /** The agent accepted the stream and is producing. */
  readonly started: () => void;
  /** One delivery, with what the agent had to discard before it. */
  readonly chunk: (payload: unknown, dropped: number) => void;
  /** The stream is over. Nothing else will arrive for it. */
  readonly ended: (reason: string, error?: { code: string; message: string }) => void;
}

/** A running stream, from the caller's side. */
export interface StreamHandle {
  readonly streamId: string;
  /** Ends the stream, telling the agent to stop reading. */
  readonly cancel: () => void;
}

interface RunningStream {
  readonly agentId: string;
  readonly capability: StreamingCapability;
  readonly requestId: string;
  readonly streamId: string;
  readonly socket: TLSSocket;
  readonly observer: StreamObserver;
  /** Numbers the deliveries, so an out-of-order chunk is visible. */
  next: number;
  acknowledged: boolean;
  ended: boolean;
  timer?: NodeJS.Timeout;
}

interface PendingRequest {
  readonly agentId: string;
  readonly capability: Capability;
  /**
   * The connection the request went out on.
   *
   * A reply is only accepted from this exact socket. Without it, a reply that
   * arrives late on a replaced connection could satisfy a request belonging to
   * the new one, and the caller would read one host's answer as another's.
   */
  readonly socket: TLSSocket;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (payload: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Capability dispatch.
 *
 * The only way to reach an agent. A caller names a capability from the catalog
 * and an agent from the registry; it cannot hand through a string of its own,
 * so no REST caller can reach an operation the product has not defined.
 */
@Injectable()
export class AgentDispatchService {
  private readonly pending = new Map<string, PendingRequest>();

  /**
   * Streams currently running, by request identifier.
   *
   * Held here rather than by the caller because a stream has to survive the
   * request that opened it and end with the connection that carries it.
   */
  private readonly streams = new Map<string, RunningStream>();

  constructor(
    private readonly connections: AgentConnectionManager,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Requests are only in flight while their connection is; nothing is durable. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Streams currently running, used by the registry that limits them. */
  get streamCount(): number {
    return this.streams.size;
  }

  async request<T = unknown>(
    agentId: string,
    capability: Capability,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    if (!isCapability(capability)) {
      throw new AppError('AGENT_CAPABILITY_UNSUPPORTED', 'The capability is not supported.');
    }

    const connection = this.connections.get(agentId);

    if (!connection) {
      throw AppError.conflict('AGENT_NOT_CONNECTED', 'The agent is not connected.');
    }

    const id = randomUUID();
    const timeoutMs = CAPABILITY_TIMEOUT_MS[capability];
    const issuedAt = new Date();

    const message: CapabilityRequestMessage = {
      type: 'request',
      protocolVersion: PROTOCOL_VERSION,
      id,
      capability,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + timeoutMs).toISOString(),
      payload,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          AppError.conflict(
            'AGENT_REQUEST_TIMEOUT',
            `The agent did not answer ${capability} in time.`,
          ),
        );
      }, timeoutMs);

      // Not keeping the process alive for an answer that may never come.
      timer.unref?.();

      this.pending.set(id, {
        agentId,
        capability,
        socket: connection.socket,
        timer,
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      connection.socket.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          this.settleWithError(id, new Error('The request could not be sent.'));
        }
      });
    });
  }

  /**
   * Matches a reply to its request.
   *
   * Returns false when the reply cannot be accounted for, which the gateway
   * treats as a protocol violation. An unmatched reply is either a duplicate,
   * one for a request that already timed out, or one invented by the agent.
   */
  settle(socket: TLSSocket, message: CapabilityResponseMessage): boolean {
    const pending = this.pending.get(message.id);

    if (!pending) {
      return false;
    }

    if (pending.socket !== socket) {
      this.logger.warn(
        {
          event: 'agent_response_wrong_connection',
          agentId: pending.agentId,
          requestId: message.id,
        },
        'a reply arrived on a connection that did not make the request',
      );
      return false;
    }

    if (pending.capability !== message.capability) {
      this.logger.warn(
        {
          event: 'agent_response_capability_mismatch',
          agentId: pending.agentId,
          requestId: message.id,
          expected: pending.capability,
          received: message.capability,
        },
        'a reply answered a different capability than the one requested',
      );

      this.settleWithError(
        message.id,
        new AppError('AGENT_RESPONSE_INVALID', 'The agent answered a different capability.'),
      );

      return false;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.status === 'error') {
      const code = agentErrorCode(message.error?.code);

      // The host's own wording stays here, where it helps diagnose and is not
      // addressed to an operator.
      this.logger.warn(
        {
          event: 'agent_capability_failed',
          agentId: pending.agentId,
          requestId: message.id,
          capability: pending.capability,
          code,
          reported: message.error?.message,
        },
        'a capability failed on the agent',
      );

      pending.reject(new AppError(code as ErrorCode, agentErrorMessage(code)));

      return true;
    }

    pending.resolve(message.payload);
    return true;
  }

  /**
   * Opens a stream on an agent.
   *
   * The stream identifier is generated here and travels with the request, so
   * everything the agent sends back can be bound to the stream this call
   * opened. The agent echoes it; it never invents one.
   */
  openStream(
    agentId: string,
    capability: StreamingCapability,
    payload: Record<string, unknown>,
    observer: StreamObserver,
  ): StreamHandle {
    if (!isStreaming(capability)) {
      throw new AppError('AGENT_CAPABILITY_UNSUPPORTED', 'The capability is not a stream.');
    }

    const connection = this.connections.get(agentId);

    if (!connection) {
      throw AppError.conflict('AGENT_NOT_CONNECTED', 'The agent is not connected.');
    }

    const requestId = randomUUID();
    const streamId = randomUUID();
    const issuedAt = new Date();
    const acceptMs = CAPABILITY_TIMEOUT_MS[capability];

    const stream: RunningStream = {
      agentId,
      capability,
      requestId,
      streamId,
      socket: connection.socket,
      observer,
      next: 0,
      acknowledged: false,
      ended: false,
    };

    /*
     * The agent has a bounded time to accept. After that the stream is treated
     * as never started rather than left waiting: a request that was lost must
     * not hold a slot in the stream limits for the lifetime of the connection.
     */
    stream.timer = setTimeout(() => {
      if (!stream.acknowledged) {
        this.endStream(requestId, 'failed', {
          code: 'LOG_STREAM_UNAVAILABLE',
          message: 'The agent did not start the stream.',
        });
      }
    }, acceptMs);

    stream.timer.unref?.();

    this.streams.set(requestId, stream);

    const message: CapabilityRequestMessage = {
      type: 'request',
      protocolVersion: PROTOCOL_VERSION,
      id: requestId,
      capability,
      streamId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + acceptMs).toISOString(),
      payload,
    };

    connection.socket.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        this.endStream(requestId, 'failed', {
          code: 'LOG_STREAM_UNAVAILABLE',
          message: 'The stream could not be requested.',
        });
      }
    });

    return {
      streamId,
      cancel: () => this.cancelStream(requestId),
    };
  }

  /** Accepts an acknowledgement, or refuses one that cannot be placed. */
  acceptStreamStart(socket: TLSSocket, message: StreamStartedMessage): boolean {
    const stream = this.streamFor(socket, message.id, message.streamId);

    if (!stream || stream.capability !== message.capability) {
      return false;
    }

    if (stream.timer) {
      clearTimeout(stream.timer);
    }

    stream.acknowledged = true;
    stream.observer.started();

    return true;
  }

  /** Delivers one chunk to whoever opened the stream. */
  acceptStreamChunk(socket: TLSSocket, message: StreamChunkMessage): boolean {
    const stream = this.streamFor(socket, message.id, message.streamId);

    if (!stream) {
      return false;
    }

    if (message.seq !== stream.next) {
      /*
       * A gap or a repeat. Neither can be repaired here — the agent does not
       * keep what it has already sent — so the stream ends rather than showing
       * an operator a log with a hole they cannot see.
       */
      this.logger.warn(
        {
          event: 'log_stream_out_of_order',
          agentId: stream.agentId,
          streamId: stream.streamId,
          expected: stream.next,
          received: message.seq,
        },
        'a log chunk arrived out of order',
      );

      this.endStream(message.id, 'failed', {
        code: 'LOG_STREAM_UNAVAILABLE',
        message: 'The stream lost its place.',
      });

      return false;
    }

    stream.next += 1;
    stream.observer.chunk(message.payload, message.dropped);

    return true;
  }

  /** Ends a stream the agent has finished. */
  acceptStreamEnd(socket: TLSSocket, message: StreamEndMessage): boolean {
    const stream = this.streamFor(socket, message.id, message.streamId);

    if (!stream) {
      return false;
    }

    this.endStream(message.id, message.reason, message.error);

    return true;
  }

  /**
   * Finds the stream a message belongs to.
   *
   * Three things have to agree: the request, the stream identifier this server
   * assigned, and the connection it went out on. A chunk produced on a
   * connection that has since been replaced is refused here rather than
   * delivered into a stream that belongs to the new one.
   */
  private streamFor(
    socket: TLSSocket,
    requestId: string,
    streamId: string,
  ): RunningStream | undefined {
    const stream = this.streams.get(requestId);

    if (!stream || stream.ended) {
      return undefined;
    }

    if (stream.streamId !== streamId || stream.socket !== socket) {
      this.logger.warn(
        {
          event: 'log_stream_message_rejected',
          agentId: stream.agentId,
          streamId: stream.streamId,
          received: streamId,
          sameConnection: stream.socket === socket,
        },
        'a stream message did not belong to the stream it named',
      );

      return undefined;
    }

    return stream;
  }

  /** Tells the agent to stop, and ends the stream here whatever it answers. */
  private cancelStream(requestId: string): void {
    const stream = this.streams.get(requestId);

    if (!stream || stream.ended) {
      return;
    }

    const cancel: StreamCancelMessage = {
      type: 'stream_cancel',
      protocolVersion: PROTOCOL_VERSION,
      id: stream.requestId,
      streamId: stream.streamId,
    };

    if (!stream.socket.destroyed) {
      stream.socket.write(`${JSON.stringify(cancel)}\n`, () => undefined);
    }

    this.endStream(requestId, 'cancelled');
  }

  private endStream(
    requestId: string,
    reason: string,
    error?: { code: string; message: string },
  ): void {
    const stream = this.streams.get(requestId);

    if (!stream || stream.ended) {
      return;
    }

    stream.ended = true;

    if (stream.timer) {
      clearTimeout(stream.timer);
    }

    this.streams.delete(requestId);
    stream.observer.ended(reason, error);
  }

  /** Fails everything still waiting on a connection that has gone away. */
  abandon(socket: TLSSocket): void {
    for (const [id, pending] of this.pending) {
      if (pending.socket === socket) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(
          AppError.conflict('AGENT_NOT_CONNECTED', 'The connection closed before an answer.'),
        );
      }
    }

    /*
     * A stream cannot outlive its connection. The agent has already stopped
     * reading — it ends its own streams when a session closes — and anything
     * that arrived afterwards would belong to a different session anyway.
     */
    for (const [requestId, stream] of this.streams) {
      if (stream.socket === socket) {
        this.endStream(requestId, 'failed', {
          code: 'AGENT_NOT_CONNECTED',
          message: 'The agent disconnected.',
        });
      }
    }
  }

  /** Ends every stream of an agent, used when a credential is revoked. */
  endStreamsOf(agentId: string, code: string, message: string): number {
    let ended = 0;

    for (const [requestId, stream] of this.streams) {
      if (stream.agentId === agentId) {
        this.endStream(requestId, 'failed', { code, message });
        ended += 1;
      }
    }

    return ended;
  }

  private settleWithError(id: string, error: Error): void {
    const pending = this.pending.get(id);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }
}
