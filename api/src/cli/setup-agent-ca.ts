/**
 * Creates the agent certificate authority and the gateway server certificate.
 *
 * Run once per deployment, deliberately and never as part of starting the
 * server. Replacing the CA invalidates every enrolled agent, so the command
 * refuses to overwrite existing material.
 *
 *   npm run setup:agent-ca -- ./pki dockplane.example.com
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createCertificateAuthority } from '../agents/pki';
import { createGatewayCertificate } from '../agents/gateway-certificate';

const CA_LIFETIME_SECONDS = 10 * 365 * 24 * 3600;
const GATEWAY_LIFETIME_SECONDS = 2 * 365 * 24 * 3600;

/** Owner-only. The CA key is the root of agent trust. */
const KEY_MODE = 0o600;
const CERT_MODE = 0o644;

async function main(): Promise<void> {
  const directory = resolve(process.argv[2] ?? './pki');
  const hostnames = (process.argv[3] ?? 'localhost').split(',').map((entry) => entry.trim());

  const paths = {
    caCert: join(directory, 'agent-ca.crt'),
    caKey: join(directory, 'agent-ca.key'),
    gatewayCert: join(directory, 'gateway.crt'),
    gatewayKey: join(directory, 'gateway.key'),
  };

  const existing = Object.values(paths).filter((path) => existsSync(path));

  if (existing.length > 0) {
    throw new Error(
      `Refusing to overwrite existing PKI material:\n  ${existing.join('\n  ')}\n` +
        'Remove it deliberately, and re-enroll every agent, before creating a new authority.',
    );
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });

  const ca = await createCertificateAuthority('Dockplane Agent CA', CA_LIFETIME_SECONDS);
  await writeFile(paths.caCert, ca.certificatePem, { mode: CERT_MODE });
  await writeFile(paths.caKey, ca.privateKeyPem, { mode: KEY_MODE });

  const gateway = await createGatewayCertificate(ca, hostnames, GATEWAY_LIFETIME_SECONDS);
  await writeFile(paths.gatewayCert, gateway.certificatePem, { mode: CERT_MODE });
  await writeFile(paths.gatewayKey, gateway.privateKeyPem, { mode: KEY_MODE });

  process.stdout.write(
    [
      'Created agent PKI material.',
      '',
      `  AGENT_CA_CERT_PATH=${paths.caCert}`,
      `  AGENT_CA_KEY_PATH=${paths.caKey}`,
      `  AGENT_CLIENT_CA_CERT_PATH=${paths.caCert}`,
      `  AGENT_GATEWAY_TLS_CERT_PATH=${paths.gatewayCert}`,
      `  AGENT_GATEWAY_TLS_KEY_PATH=${paths.gatewayKey}`,
      '',
      `Gateway certificate is valid for: ${hostnames.join(', ')}`,
      'Back up this directory. Losing the CA key requires re-enrolling every agent.',
      '',
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
