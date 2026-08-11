import { Injectable } from '@nestjs/common';
import { TLSSocket } from 'node:tls';

export interface AgentConnection {
  readonly agentId: string;
  readonly socket: TLSSocket;
  readonly connectedAt: Date;
  readonly remoteAddress?: string;
}

/**
 * Live agent connections.
 *
 * This is deliberately in-memory and never persisted. A connection is a
 * property of this process, so a restart starts from nothing rather than
 * reporting agents as connected that no longer are.
 *
 * Duplicate connection policy: the newest connection wins. An agent that
 * reconnects after a network partition would otherwise be locked out by its own
 * half-open predecessor until a timeout expired, which is the more common and
 * more damaging failure. The previous socket is closed immediately, so a stolen
 * certificate cannot quietly ride alongside the legitimate agent either.
 */
@Injectable()
export class AgentConnectionManager {
  private readonly connections = new Map<string, AgentConnection>();

  /** Registers a connection, closing any earlier one for the same identity. */
  register(agentId: string, socket: TLSSocket): AgentConnection {
    const previous = this.connections.get(agentId);

    if (previous && previous.socket !== socket) {
      previous.socket.destroy();
    }

    const connection: AgentConnection = {
      agentId,
      socket,
      connectedAt: new Date(),
      remoteAddress: socket.remoteAddress,
    };

    this.connections.set(agentId, connection);

    return connection;
  }

  /** Removes a connection, but only if it is still the current one. */
  release(agentId: string, socket: TLSSocket): boolean {
    const current = this.connections.get(agentId);

    if (current?.socket === socket) {
      this.connections.delete(agentId);
      return true;
    }

    return false;
  }

  /** Ends the live connection of an agent, used when a credential is revoked. */
  disconnect(agentId: string): boolean {
    const connection = this.connections.get(agentId);

    if (!connection) {
      return false;
    }

    connection.socket.destroy();
    this.connections.delete(agentId);

    return true;
  }

  /** The live connection of an agent, used to dispatch a capability request. */
  get(agentId: string): AgentConnection | undefined {
    return this.connections.get(agentId);
  }

  isConnected(agentId: string): boolean {
    return this.connections.has(agentId);
  }

  get count(): number {
    return this.connections.size;
  }

  connectedAgentIds(): string[] {
    return [...this.connections.keys()];
  }

  /** Closes every connection, used on shutdown. */
  closeAll(): void {
    for (const connection of this.connections.values()) {
      connection.socket.destroy();
    }

    this.connections.clear();
  }
}
