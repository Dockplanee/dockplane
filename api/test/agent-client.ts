import { TLSSocket, connect } from 'node:tls';

/**
 * Minimal gateway client for the integration tests.
 *
 * This is test infrastructure, not the Dockplane agent. It exists only to prove
 * that the server side of the trust chain behaves correctly over a real TLS
 * connection; the real agent is a separate milestone.
 */
export interface TestAgentOptions {
  readonly port: number;
  readonly certificatePem?: string;
  readonly privateKeyPem?: string;
  readonly caPem: string;
  readonly host?: string;
}

export class TestAgentConnection {
  /**
   * Every connection this process has opened and not yet closed.
   *
   * A connection that outlives the test that opened it keeps the server
   * polling the agent behind it, long after the test's data has been cleared.
   * That work then competes with later tests for the connection pool and the
   * event loop, which is how one suite makes another one flaky.
   */
  private static readonly live = new Set<TestAgentConnection>();

  private readonly received: Record<string, unknown>[] = [];
  private readonly handlers: ((message: Record<string, unknown>) => void)[] = [];
  private buffer = '';
  private closed = false;

  private constructor(private readonly socket: TLSSocket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');

      let newline = this.buffer.indexOf('\n');
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);

        if (line) {
          try {
            const message = JSON.parse(line) as Record<string, unknown>;

            this.received.push(message);

            for (const handler of this.handlers) {
              handler(message);
            }
          } catch {
            // A non-JSON line is a protocol failure the test will notice.
          }
        }

        newline = this.buffer.indexOf('\n');
      }
    });

    socket.on('close', () => {
      this.closed = true;
    });
  }

  /** Opens a TLS connection, rejecting if the handshake fails. */
  static open(options: TestAgentOptions): Promise<TestAgentConnection> {
    return new Promise((resolve, reject) => {
      const socket = connect({
        host: options.host ?? '127.0.0.1',
        port: options.port,
        cert: options.certificatePem,
        key: options.privateKeyPem,
        ca: options.caPem,
        servername: 'localhost',
        rejectUnauthorized: true,
      });

      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };

      socket.once('error', onError);
      socket.once('secureConnect', () => {
        socket.removeListener('error', onError);
        socket.on('error', () => socket.destroy());

        const connection = new TestAgentConnection(socket);

        TestAgentConnection.live.add(connection);
        resolve(connection);
      });
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  /** Sends a raw payload, used to exercise malformed and oversized input. */
  sendRaw(payload: string): void {
    this.socket.write(payload);
  }

  /**
   * Registers a handler for every incoming message.
   *
   * Used by tests that have to answer the server rather than only observe it,
   * such as a scripted agent replying to capability requests.
   */
  onMessage(handler: (message: Record<string, unknown>) => void): void {
    this.handlers.push(handler);
  }

  /** Waits for the next message of a given type, or times out. */
  /**
   * Waits for the next message of a given type.
   *
   * The budget covers a TLS handshake and the database work the gateway does
   * before it answers. Three seconds was enough on an idle machine and not on a
   * busy one, which made this the source of an intermittent failure rather than
   * a real one.
   */
  async waitFor(type: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const found = this.received.find((message) => message.type === type);

      if (found) {
        return found;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error(`Timed out waiting for "${type}". ${this.describe()}`);
  }

  /**
   * Waits until a given number of messages of a type have arrived.
   *
   * waitFor returns the first match every time, which is what most assertions
   * want. A test with several requests in flight needs all of them.
   */
  async waitForAll(
    type: string,
    count: number,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>[]> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const found = this.received.filter((message) => message.type === type);

      if (found.length >= count) {
        return found;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error(`Timed out waiting for ${count} "${type}" messages. ${this.describe()}`);
  }

  async waitForClose(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.closed) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error('The connection did not close');
  }

  /**
   * What the connection looked like when it gave up.
   *
   * A timeout on its own cannot distinguish a server that stayed silent from
   * one that was never reached: a connection to the wrong listener, or one the
   * server closed, look the same from the assertion. The addresses and the
   * socket state say which happened.
   */
  private describe(): string {
    const socket = this.socket;

    return [
      `Received: ${JSON.stringify(this.received)}`,
      `connection: ${socket.localAddress ?? '?'}:${socket.localPort ?? 0}` +
        ` -> ${socket.remoteAddress ?? '?'}:${socket.remotePort ?? 0}`,
      `state: ${this.closed ? 'closed' : socket.destroyed ? 'destroyed' : 'open'}`,
      `authorized: ${socket.authorized}`,
      `pending bytes: ${JSON.stringify(this.buffer)}`,
    ].join(', ');
  }

  get messages(): readonly Record<string, unknown>[] {
    return this.received;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    TestAgentConnection.live.delete(this);
    this.socket.destroy();
  }

  /** Closes whatever a test left open. Registered globally in test/setup.ts. */
  static closeAll(): void {
    for (const connection of [...TestAgentConnection.live]) {
      connection.close();
    }
  }
}
