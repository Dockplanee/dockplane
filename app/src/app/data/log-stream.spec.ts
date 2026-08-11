import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { API_BASE_URL } from '../core/api-config';
import { DockplaneApi, LogEvent } from './dockplane-api';
import { RealDockplaneApi } from './real-dockplane-api';

/**
 * Reading the event stream.
 *
 * The stream is read with `fetch` rather than `EventSource`, so the parsing is
 * ours and worth testing directly: what becomes an event, what does not, and
 * what happens when the request is refused or abandoned.
 */
describe('log stream', () => {
  let api: DockplaneApi;
  let original: typeof globalThis.fetch;
  /** The signal the implementation passed to fetch, so a test can watch it. */
  let signal: AbortSignal | undefined;

  /** Serves a scripted event stream, one chunk at a time. */
  const serve = (chunks: readonly string[], status = 200) => {
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;

      if (status !== 200) {
        return Promise.resolve(
          new Response(JSON.stringify({ code: 'PERMISSION_DENIED' }), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }

      let index = 0;

      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (signal?.aborted) {
            controller.close();
            return;
          }

          if (index >= chunks.length) {
            controller.close();
            return;
          }

          controller.enqueue(new TextEncoder().encode(chunks[index]));
          index += 1;
        },
      });

      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof globalThis.fetch;
  };

  const collect = (): Promise<LogEvent[]> =>
    new Promise((resolve, reject) => {
      const events: LogEvent[] = [];

      api.streamContainerLogs('container-1').subscribe({
        next: (event) => events.push(event),
        error: reject,
        complete: () => resolve(events),
      });
    });

  beforeEach(() => {
    original = globalThis.fetch;
    signal = undefined;

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '' },
        { provide: DockplaneApi, useClass: RealDockplaneApi },
      ],
    });

    api = TestBed.inject(DockplaneApi);
  });

  afterEach(() => {
    globalThis.fetch = original;
  });

  it('reads lines and the end of a stream', async () => {
    serve([
      'event: open\ndata: {"streamId":"stream-1"}\n\n',
      'event: lines\ndata: {"lines":[{"stream":"stdout","message":"ready"}]}\n\n',
      'event: end\ndata: {"reason":"completed"}\n\n',
    ]);

    const events = await collect();

    expect(events.map((event) => event.kind)).toEqual(['open', 'lines', 'end']);
  });

  /**
   * A keepalive is not output.
   *
   * The server writes a comment to hold a quiet connection open. It carries no
   * event and no data, and it must never reach the viewer as a line — an
   * invented line in a log is worse than a gap.
   */
  it('ignores the keepalive comment', async () => {
    serve([
      'event: open\ndata: {"streamId":"stream-1"}\n\n',
      ': keepalive\n\n',
      ': keepalive\n\n',
      'event: lines\ndata: {"lines":[{"stream":"stdout","message":"ready"}]}\n\n',
      ': keepalive\n\n',
      'event: end\ndata: {"reason":"completed"}\n\n',
    ]);

    const events = await collect();

    expect(events.map((event) => event.kind)).toEqual(['open', 'lines', 'end']);

    const lines = events.find((event) => event.kind === 'lines');

    expect(lines?.kind === 'lines' && lines.lines).toHaveLength(1);
  });

  it('reads a frame that arrives in pieces', async () => {
    serve([
      'event: lines\ndata: {"lines":[{"stream":"std',
      'err","message":"split across chunks"}]}\n\n',
      'event: end\ndata: {"reason":"completed"}\n\n',
    ]);

    const events = await collect();
    const lines = events[0];

    expect(lines.kind).toBe('lines');
    expect(lines.kind === 'lines' && lines.lines[0]).toMatchObject({
      stream: 'stderr',
      message: 'split across chunks',
    });
  });

  /**
   * A refusal is reported with the server's own code.
   *
   * The viewer names the reason it could not read, rather than showing a
   * connection that silently never produces anything.
   */
  it('reports a refusal with the code the server sent', async () => {
    serve([], 403);

    const events = await collect();

    expect(events).toEqual([{ kind: 'end', reason: 'failed', code: 'PERMISSION_DENIED' }]);
  });

  /**
   * Unsubscribing ends the request.
   *
   * The connection closing is what stops the control server, and through it the
   * Docker reader on the host. Nothing else tells either of them.
   */
  it('abandons the request when the subscriber leaves', async () => {
    serve(['event: open\ndata: {"streamId":"stream-1"}\n\n']);

    await new Promise<void>((resolve) => {
      const subscription = api.streamContainerLogs('container-1').subscribe({
        next: () => {
          subscription.unsubscribe();
          resolve();
        },
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    // The request itself is abandoned, which is what the server observes: the
    // connection closes, and the control server stops the read on the host.
    expect(signal?.aborted).toBe(true);
  });
});
