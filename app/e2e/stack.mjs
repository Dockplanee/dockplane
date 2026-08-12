/**
 * An ephemeral Dockplane, for browser tests.
 *
 * The search palette defect that reached 0.1.0-rc.1 was invisible to a unit
 * test: it needed the real stylesheet, the real cascade and a real user agent.
 * So these tests need a real instance — but not somebody's.
 *
 * This builds one and throws it away: a PostgreSQL container on a free port, a
 * control server from api/dist, and one origin serving the built application
 * with /api proxied to that server, which is what the browser needs because the
 * application calls same-origin paths.
 *
 * The administrator is created here with a password generated for this run. No
 * credential is read from the environment, none is written to disk, and none is
 * reused. Nothing here ever points at a deployment somebody is using.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})\n${result.stderr || result.stdout || ''}`,
    );
  }

  // stdio: 'ignore' leaves these null rather than empty.
  return (result.stdout ?? '').trim();
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(what, check, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;

  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error;
    }
    await sleep(400);
  }

  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

/**
 * The agent authority, created by the command a deployment uses.
 *
 * Hand-rolling a pair here would be a second implementation of the one thing
 * every agent's identity chains to, and a test instance whose PKI differs from
 * a real one is not the thing being tested.
 */
function agentPki(directory) {
  const pki = join(directory, 'pki');

  run('node', [join(repo, 'api', 'dist', 'cli', 'setup-agent-ca.js'), pki, 'localhost,127.0.0.1'], {
    cwd: join(repo, 'api'),
    stdio: 'ignore',
  });

  return {
    caCert: join(pki, 'agent-ca.crt'),
    caKey: join(pki, 'agent-ca.key'),
    gatewayCert: join(pki, 'gateway.crt'),
    gatewayKey: join(pki, 'gateway.key'),
  };
}

export async function startStack({ log = console.log } = {}) {
  const apiDist = join(repo, 'api', 'dist', 'main.js');
  const appDist = join(repo, 'app', 'dist', 'dockplane-app', 'browser');

  if (!existsSync(apiDist)) throw new Error(`build the control server first: ${apiDist}`);
  if (!existsSync(appDist)) throw new Error(`build the application first: ${appDist}`);

  const workspace = await mkdtemp(join(tmpdir(), 'dockplane-e2e-'));
  const container = `dockplane-e2e-db-${randomUUID().slice(0, 8)}`;
  const stopped = [];

  const teardown = async () => {
    for (const stop of stopped.reverse()) {
      try {
        await stop();
      } catch {
        // Tearing down is best effort; a failure here must not mask a result.
      }
    }
    await rm(workspace, { recursive: true, force: true });
  };

  try {
    // --- the database ------------------------------------------------------
    const databasePort = await freePort();
    const databasePassword = randomBytes(18).toString('base64url');

    log(`  postgres on ${databasePort}`);
    run('docker', [
      'run', '--detach', '--rm', '--name', container,
      '--publish', `127.0.0.1:${databasePort}:5432`,
      '--env', `POSTGRES_PASSWORD=${databasePassword}`,
      '--env', 'POSTGRES_USER=dockplane',
      '--env', 'POSTGRES_DB=dockplane',
      'postgres:17.6-bookworm',
    ]);

    stopped.push(() => {
      spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' });
    });

    const databaseUrl = `postgres://dockplane:${databasePassword}@127.0.0.1:${databasePort}/dockplane`;

    await waitFor('postgres', () => {
      const ready = spawnSync('docker', [
        'exec', container, 'pg_isready', '--username', 'dockplane', '--dbname', 'dockplane',
      ]);
      return ready.status === 0;
    });

    // --- the control server ------------------------------------------------
    const pki = agentPki(workspace);
    const apiPort = await freePort();
    const gatewayPort = await freePort();
    const originPort = await freePort();
    const origin = `http://127.0.0.1:${originPort}`;

    const environment = {
      ...process.env,
      NODE_ENV: 'development',
      DATABASE_URL: databaseUrl,
      PORT: String(apiPort),
      PUBLIC_APP_URL: origin,
      APPLICATION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      AGENT_GATEWAY_ADVERTISED_URL: `https://127.0.0.1:${gatewayPort}`,
      AGENT_GATEWAY_PORT: String(gatewayPort),
      AGENT_GATEWAY_HOST: '127.0.0.1',
      AGENT_GATEWAY_TLS_CERT_PATH: pki.gatewayCert,
      AGENT_GATEWAY_TLS_KEY_PATH: pki.gatewayKey,
      AGENT_CLIENT_CA_CERT_PATH: pki.caCert,
      AGENT_CA_CERT_PATH: pki.caCert,
      AGENT_CA_KEY_PATH: pki.caKey,
      // The browser reaches this over plain HTTP on loopback.
      DEV_ALLOW_INSECURE_COOKIES: 'true',
      // A build from a working copy names no release, and Add host refuses to
      // hand out a version it cannot point at. Pinned the way a rehearsal is.
      AGENT_RELEASE_VERSION: '0.1.0',
      LOG_LEVEL: 'warn',
    };

    log('  migrations');
    run('node', [join(repo, 'api', 'dist', 'cli', 'migrate.js')], {
      cwd: join(repo, 'api'),
      env: environment,
    });

    // Generated for this run, used by the browser, and gone with the process.
    const email = 'e2e@dockplane.invalid';
    const password = `e2e-${randomBytes(24).toString('base64url')}`;

    log('  administrator');
    run('node', [join(repo, 'api', 'dist', 'cli', 'bootstrap-admin.js'), email, 'E2E'], {
      cwd: join(repo, 'api'),
      env: { ...environment, DOCKPLANE_BOOTSTRAP_PASSWORD: password },
    });

    log(`  control server on ${apiPort}`);
    const server = spawn('node', [apiDist], {
      cwd: join(repo, 'api'),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let serverOutput = '';
    server.stdout.on('data', (chunk) => (serverOutput += chunk));
    server.stderr.on('data', (chunk) => (serverOutput += chunk));
    server.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`control server exited with ${code}:\n${serverOutput}`);
      }
    });

    stopped.push(
      () =>
        new Promise((resolve) => {
          server.once('exit', resolve);
          server.kill('SIGTERM');
          setTimeout(() => server.kill('SIGKILL'), 5_000).unref();
        }),
    );

    // --- one origin, the way a deployment serves it ------------------------
    const proxy = createServer((incoming, outgoing) => {
      if (incoming.url.startsWith('/api/') || incoming.url.startsWith('/health')) {
        const forwarded = httpRequest(
          {
            host: '127.0.0.1',
            port: apiPort,
            path: incoming.url,
            method: incoming.method,
            headers: { ...incoming.headers, host: `127.0.0.1:${apiPort}` },
          },
          (answer) => {
            outgoing.writeHead(answer.statusCode, answer.headers);
            answer.pipe(outgoing);
          },
        );

        forwarded.on('error', () => {
          outgoing.writeHead(502).end('the control server did not answer');
        });

        incoming.pipe(forwarded);
        return;
      }

      // The application is a single page: anything that is not a file it
      // shipped is its own route.
      const requested = normalize(decodeURIComponent(incoming.url.split('?')[0])).replace(
        /^(\.\.[/\\])+/,
        '',
      );
      let file = join(appDist, requested);

      if (!file.startsWith(appDist) || !existsSync(file) || !extname(file)) {
        file = join(appDist, 'index.html');
      }

      outgoing.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      createReadStream(file).pipe(outgoing);
    });

    await new Promise((resolve) => proxy.listen(originPort, '127.0.0.1', resolve));
    stopped.push(() => new Promise((resolve) => proxy.close(resolve)));

    log(`  serving ${origin}`);

    await waitFor('the control server', async () => {
      const answer = await fetch(`${origin}/health/ready`).catch(() => null);
      return answer?.ok === true;
    });

    await waitFor('the application', async () => {
      const answer = await fetch(origin).catch(() => null);
      return answer?.ok === true;
    });

    return { url: origin, email, password, teardown };
  } catch (error) {
    await teardown();
    throw error;
  }
}

/** Signs in over the API and returns a browser-ready cookie and CSRF token. */
export async function signIn({ url, email, password }) {
  const answer = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url },
    body: JSON.stringify({ email, password }),
  });

  if (!answer.ok) {
    throw new Error(`sign-in failed: ${answer.status} ${await answer.text()}`);
  }

  const body = await answer.json();

  if (body.status !== 'authenticated') {
    throw new Error(`sign-in did not complete: ${body.status}`);
  }

  const cookie = (answer.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(';')[0])
    .join('; ');

  return { cookie, csrfToken: body.csrfToken };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stack = await startStack();
  console.log(JSON.stringify({ url: stack.url, email: stack.email }, null, 2));
  await writeFile(join(tmpdir(), 'dockplane-e2e-url'), stack.url);
  process.on('SIGINT', () => stack.teardown().then(() => process.exit(0)));
}
