/**
 * Runs the browser suites against an instance built for this run and thrown
 * away afterwards.
 *
 *   npm run e2e
 *
 * Nothing here reads a credential from the environment or points at a
 * deployment. The stack generates its own administrator password, and the
 * database goes with the container.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStack } from './stack.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/*
 * The agent harness runs first.
 *
 * Every container the later suites manage goes through it, so a fault there
 * would fail those suites for reasons that have nothing to do with the
 * interface. Proving the path once, without a browser, keeps the browser
 * failures about the browser.
 */
const SUITES = [
  ['agent harness', 'agent-harness.e2e.mjs'],
  ['search palette', 'search-palette.e2e.mjs'],
  ['add host wizard', 'add-host-wizard.e2e.mjs'],
];

function runSuite(file, environment) {
  return new Promise((resolve) => {
    const child = spawn('node', [join(here, file)], {
      env: environment,
      stdio: 'inherit',
    });

    child.on('exit', (code) => resolve(code ?? 1));
  });
}

console.log('==> bringing up an instance for this run');
const stack = await startStack();

let failed = 0;

try {
  const environment = {
    ...process.env,
    DOCKPLANE_URL: stack.url,
    DOCKPLANE_EMAIL: stack.email,
    DOCKPLANE_PASSWORD: stack.password,
    // What a suite needs to bring a host of its own.
    DOCKPLANE_GATEWAY_PORT: String(stack.gatewayPort),
    DOCKPLANE_AGENT_CA_PEM_PATH: stack.caCertPath,
  };

  for (const [name, file] of SUITES) {
    console.log(`\n==== ${name} ====`);
    const status = await runSuite(file, environment);

    if (status !== 0) {
      failed += 1;
      console.error(`  ${name} failed`);
    }
  }
} finally {
  console.log('\n==> tearing it down');
  await stack.teardown();
}

if (failed > 0) {
  console.error(`\n${failed} suite(s) failed`);
  process.exit(1);
}

console.log('\nall browser suites passed');
