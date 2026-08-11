/**
 * Agent gateway protocol.
 *
 * Two kinds of traffic share one connection: liveness, which the agent starts,
 * and capability requests, which the server starts. Both are versioned, and
 * every capability request carries its own identifier and expiry, so a reply
 * can be correlated and a stale request can be refused rather than run late.
 */

import { Capability, isCapability } from './capabilities';

export const PROTOCOL_VERSION = 1;
export const MINIMUM_PROTOCOL_VERSION = 1;

export function isSupportedProtocolVersion(version: unknown): version is number {
  return (
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version >= MINIMUM_PROTOCOL_VERSION &&
    version <= PROTOCOL_VERSION
  );
}

export interface HelloMessage {
  readonly type: 'hello';
  readonly protocolVersion: number;
  readonly agentVersion?: string;
  /** Advertised by the agent. None are honoured in this milestone. */
  readonly capabilities?: readonly string[];
}

export interface HeartbeatMessage {
  readonly type: 'heartbeat';
  readonly protocolVersion: number;
}

export interface CertificateRenewalMessage {
  readonly type: 'certificate.renew';
  readonly protocolVersion: number;
  readonly csr: string;
}

/**
 * A capability result.
 *
 * The capability is echoed so the server can refuse a reply that answers a
 * different question than the one it asked, even when the identifier matches.
 */
export interface CapabilityResponseMessage {
  readonly type: 'response';
  readonly protocolVersion: number;
  readonly id: string;
  readonly capability: Capability;
  readonly status: 'success' | 'error';
  readonly payload?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/*
 * A streaming capability reports its progress in three parts.
 *
 * The stream identifier is the server's, sent with the request and echoed
 * back, so everything that arrives can be bound to the stream it opened rather
 * than to one the agent named.
 */
export interface StreamStartedMessage {
  readonly type: 'stream_started';
  readonly protocolVersion: number;
  readonly id: string;
  readonly capability: Capability;
  readonly streamId: string;
}

export interface StreamChunkMessage {
  readonly type: 'stream_chunk';
  readonly protocolVersion: number;
  readonly id: string;
  readonly streamId: string;
  /** Numbered from zero, so a gap in delivery is visible. */
  readonly seq: number;
  readonly payload: unknown;
  /** What the agent discarded because the consumer was behind. */
  readonly dropped: number;
}

export interface StreamEndMessage {
  readonly type: 'stream_end';
  readonly protocolVersion: number;
  readonly id: string;
  readonly streamId: string;
  readonly reason: StreamEndReason;
  readonly error?: { readonly code: string; readonly message: string };
}

export const STREAM_END_REASONS = ['completed', 'cancelled', 'failed', 'expired'] as const;

export type StreamEndReason = (typeof STREAM_END_REASONS)[number];

const END_REASONS = new Set<string>(STREAM_END_REASONS);

export type ClientMessage =
  | HelloMessage
  | HeartbeatMessage
  | CertificateRenewalMessage
  | CapabilityResponseMessage
  | StreamStartedMessage
  | StreamChunkMessage
  | StreamEndMessage;

/** A capability the server asks an agent to perform. */
export interface CapabilityRequestMessage {
  readonly type: 'request';
  readonly protocolVersion: number;
  readonly id: string;
  readonly capability: Capability;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly payload: Record<string, unknown>;
  /** Present only for a streaming capability, and assigned by the server. */
  readonly streamId?: string;
}

/** Ends a stream the server no longer wants. */
export interface StreamCancelMessage {
  readonly type: 'stream_cancel';
  readonly protocolVersion: number;
  readonly id: string;
  readonly streamId: string;
}

export interface HelloAck {
  readonly type: 'hello_ack';
  readonly protocolVersion: number;
  readonly agentId: string;
  readonly heartbeatIntervalSeconds: number;
  readonly certificateNotAfter: string;
  /** When the agent should start renewing. The server owns this policy. */
  readonly renewAfter: string;
}

export interface HeartbeatAck {
  readonly type: 'heartbeat_ack';
  readonly protocolVersion: number;
}

export interface CertificateRenewed {
  readonly type: 'certificate.renewed';
  readonly protocolVersion: number;
  readonly certificate: string;
  readonly certificateNotAfter: string;
  readonly renewAfter: string;
}

export interface ProtocolError {
  readonly type: 'error';
  readonly protocolVersion: number;
  readonly code: string;
  readonly message: string;
}

export type ServerMessage =
  | HelloAck
  | HeartbeatAck
  | CertificateRenewed
  | ProtocolError
  | CapabilityRequestMessage
  | StreamCancelMessage;

export const HEARTBEAT_INTERVAL_SECONDS = 30;

/**
 * Parses one message.
 *
 * Anything that is not a known object with a known type is rejected outright;
 * the gateway never infers intent from a partially understood payload.
 */
export function parseClientMessage(raw: string): ClientMessage | undefined {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const message = value as Record<string, unknown>;

  if (typeof message.type !== 'string' || typeof message.protocolVersion !== 'number') {
    return undefined;
  }

  switch (message.type) {
    case 'hello':
      return {
        type: 'hello',
        protocolVersion: message.protocolVersion,
        agentVersion: typeof message.agentVersion === 'string' ? message.agentVersion : undefined,
        capabilities: Array.isArray(message.capabilities)
          ? message.capabilities.filter((entry): entry is string => typeof entry === 'string')
          : [],
      };

    case 'heartbeat':
      return { type: 'heartbeat', protocolVersion: message.protocolVersion };

    case 'certificate.renew':
      return typeof message.csr === 'string'
        ? { type: 'certificate.renew', protocolVersion: message.protocolVersion, csr: message.csr }
        : undefined;

    case 'response':
      return parseCapabilityResponse(message);

    case 'stream_started':
      return typeof message.id === 'string' &&
        typeof message.streamId === 'string' &&
        isCapability(message.capability)
        ? {
            type: 'stream_started',
            protocolVersion: message.protocolVersion as number,
            id: message.id,
            capability: message.capability,
            streamId: message.streamId,
          }
        : undefined;

    case 'stream_chunk':
      return parseStreamChunk(message);

    case 'stream_end':
      return typeof message.id === 'string' &&
        typeof message.streamId === 'string' &&
        typeof message.reason === 'string' &&
        END_REASONS.has(message.reason)
        ? {
            type: 'stream_end',
            protocolVersion: message.protocolVersion as number,
            id: message.id,
            streamId: message.streamId,
            reason: message.reason as StreamEndReason,
            error: parseError(message.error),
          }
        : undefined;

    default:
      return undefined;
  }
}

function parseStreamChunk(message: Record<string, unknown>): StreamChunkMessage | undefined {
  if (typeof message.id !== 'string' || typeof message.streamId !== 'string') {
    return undefined;
  }

  if (typeof message.seq !== 'number' || !Number.isInteger(message.seq) || message.seq < 0) {
    return undefined;
  }

  const dropped = typeof message.dropped === 'number' ? message.dropped : 0;

  return {
    type: 'stream_chunk',
    protocolVersion: message.protocolVersion as number,
    id: message.id,
    streamId: message.streamId,
    seq: message.seq,
    payload: message.payload,
    dropped: Number.isInteger(dropped) && dropped > 0 ? dropped : 0,
  };
}

function parseError(value: unknown): { code: string; message: string } | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const error = value as Record<string, unknown>;

  return {
    code: typeof error.code === 'string' ? error.code : 'AGENT_CAPABILITY_FAILED',
    message: typeof error.message === 'string' ? error.message : 'The capability failed.',
  };
}

function parseCapabilityResponse(
  message: Record<string, unknown>,
): CapabilityResponseMessage | undefined {
  if (typeof message.id !== 'string' || !isCapability(message.capability)) {
    return undefined;
  }

  if (message.status !== 'success' && message.status !== 'error') {
    return undefined;
  }

  return {
    type: 'response',
    protocolVersion: message.protocolVersion as number,
    id: message.id,
    capability: message.capability,
    status: message.status,
    payload: message.payload,
    error: parseError(message.error),
  };
}
