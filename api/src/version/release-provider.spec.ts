import { IncomingMessage, ServerResponse, createServer } from 'node:http';
import type { AddressInfo, Server } from 'node:net';

import { PublishedReleaseProvider, RELEASE_ENDPOINT } from './release-provider';

/**
 * The provider against a server this test owns.
 *
 * Nothing here reaches the real release listing. A test that did would fail
 * when somebody publishes, pass for a reason the test does not control, and
 * make the suite's behaviour depend on an outside party being reachable.
 */

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server;
let endpoint: string;
let handler: Handler;
let requests: { url: string | undefined; headers: NodeJS.Dict<string | string[]> }[];

beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    handler(request, response);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases/latest`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
  handler = (_request, response) => response.end();
});

function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  handler = (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}

const release = (overrides: Record<string, unknown> = {}) => ({
  tag_name: 'v0.4.0',
  html_url: 'https://github.com/Dockplanee/dockplane/releases/tag/v0.4.0',
  draft: false,
  prerelease: false,
  ...overrides,
});

describe('the published release provider', () => {
  it('reads the version and the link', async () => {
    answer(200, release());

    await expect(new PublishedReleaseProvider(endpoint).latestStable()).resolves.toEqual({
      version: '0.4.0',
      url: 'https://github.com/Dockplanee/dockplane/releases/tag/v0.4.0',
    });
  });

  it('reports nothing usable rather than failing on a draft or a candidate', async () => {
    answer(200, release({ prerelease: true }));
    await expect(new PublishedReleaseProvider(endpoint).latestStable()).resolves.toBeNull();

    answer(200, release({ draft: true }));
    await expect(new PublishedReleaseProvider(endpoint).latestStable()).resolves.toBeNull();
  });

  it('reports nothing usable for a release it cannot read a version from', async () => {
    answer(200, release({ tag_name: 'nightly' }));

    await expect(new PublishedReleaseProvider(endpoint).latestStable()).resolves.toBeNull();
  });

  it('fails on an error status', async () => {
    answer(500, { message: 'boom' });

    await expect(new PublishedReleaseProvider(endpoint).latestStable()).rejects.toThrow('500');
  });

  it('fails when the upstream rate limits', async () => {
    answer(403, { message: 'API rate limit exceeded' });

    await expect(new PublishedReleaseProvider(endpoint).latestStable()).rejects.toThrow('403');
  });

  it('fails on a body that is not the expected shape', async () => {
    answer(200, { released: 'yesterday' });

    await expect(new PublishedReleaseProvider(endpoint).latestStable()).rejects.toThrow(
      'expected shape',
    );
  });

  it('fails on a body that is not JSON at all', async () => {
    answer(200, '<html>not here</html>');

    await expect(new PublishedReleaseProvider(endpoint).latestStable()).rejects.toThrow();
  });

  it('fails when nothing is listening', async () => {
    await expect(
      new PublishedReleaseProvider('http://127.0.0.1:1/releases').latestStable(),
    ).rejects.toThrow();
  });

  // A redirect is how a request that was allowed to one host ends up at
  // another.
  it('refuses to follow a redirect', async () => {
    handler = (_request, response) => {
      response.writeHead(302, { location: 'https://example.invalid/elsewhere' });
      response.end();
    };

    await expect(new PublishedReleaseProvider(endpoint).latestStable()).rejects.toThrow();
  });

  it('stops reading a response that will not end', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"tag_name":"');
      // More than the reader accepts, written in one go.
      response.write('a'.repeat(300 * 1024));
      response.end('"}');
    };

    await expect(new PublishedReleaseProvider(endpoint).latestStable()).rejects.toThrow(
      'larger than expected',
    );
  });

  it('abandons an upstream that never answers', async () => {
    handler = () => {
      // Deliberately no response.
    };

    await expect(new PublishedReleaseProvider(endpoint).latestStable()).rejects.toThrow();
  }, 15_000);
});

describe('what the request carries', () => {
  it('sends no query string and nothing that identifies the installation', async () => {
    answer(200, release());

    await new PublishedReleaseProvider(endpoint).latestStable();

    expect(requests).toHaveLength(1);
    const [request] = requests;

    expect(request.url).toBe('/releases/latest');
    expect(request.url).not.toContain('?');

    // The whole header set, so a field added later has to be considered here.
    expect(Object.keys(request.headers).sort()).toEqual([
      'accept',
      'accept-encoding',
      'accept-language',
      'connection',
      'host',
      'sec-fetch-mode',
      'user-agent',
    ]);

    expect(request.headers['user-agent']).toBe('Dockplane');

    const sent = JSON.stringify(request).toLowerCase();

    for (const forbidden of ['installation', 'instance', 'hostname', 'dockplane.', 'agents', 'count']) {
      expect(sent).not.toContain(forbidden);
    }
  });

  it('carries no request body', async () => {
    answer(200, release());

    let body = '';
    handler = (request, response) => {
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(release()));
      });
    };

    await new PublishedReleaseProvider(endpoint).latestStable();

    expect(body).toBe('');
  });
});

describe('the upstream', () => {
  // Fixed rather than configured: there is no path by which an operator, or
  // anything an operator installs, can point the check somewhere else.
  it('is the project’s own release listing over HTTPS', () => {
    expect(RELEASE_ENDPOINT).toBe(
      'https://api.github.com/repos/Dockplanee/dockplane/releases/latest',
    );
    expect(new URL(RELEASE_ENDPOINT).protocol).toBe('https:');
    expect(new URL(RELEASE_ENDPOINT).search).toBe('');
  });
});
