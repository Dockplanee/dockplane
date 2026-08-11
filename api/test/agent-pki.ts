import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as x509 from '@peculiar/x509';

import { createCertificateAuthority } from '../src/agents/pki';
import { createGatewayCertificate } from '../src/agents/gateway-certificate';

/**
 * Certificate material for the integration tests.
 *
 * The gateway is exercised over real TLS, so the tests need a real authority,
 * a real server certificate and the ability to mint certificates from an
 * unrelated authority to prove those are rejected.
 */

const YEAR = 365 * 24 * 3600;

export interface TestPki {
  readonly directory: string;
  readonly caCertPath: string;
  readonly caKeyPath: string;
  readonly gatewayCertPath: string;
  readonly gatewayKeyPath: string;
  readonly caCertPem: string;
}

export async function createTestPki(): Promise<TestPki> {
  const directory = mkdtempSync(join(tmpdir(), 'dockplane-test-pki-'));

  const ca = await createCertificateAuthority('Dockplane Test Agent CA', YEAR);
  const gateway = await createGatewayCertificate(ca, ['localhost', '127.0.0.1'], YEAR);

  const paths = {
    caCertPath: join(directory, 'agent-ca.crt'),
    caKeyPath: join(directory, 'agent-ca.key'),
    gatewayCertPath: join(directory, 'gateway.crt'),
    gatewayKeyPath: join(directory, 'gateway.key'),
  };

  writeFileSync(paths.caCertPath, ca.certificatePem, { mode: 0o644 });
  writeFileSync(paths.caKeyPath, ca.privateKeyPem, { mode: 0o600 });
  writeFileSync(paths.gatewayCertPath, gateway.certificatePem, { mode: 0o644 });
  writeFileSync(paths.gatewayKeyPath, gateway.privateKeyPem, { mode: 0o600 });

  return { directory, ...paths, caCertPem: ca.certificatePem };
}

export interface KeyAndCsr {
  readonly csrPem: string;
  readonly privateKeyPem: string;
  readonly publicKey: CryptoKey;
}

/** Generates a key pair and a certificate request the way an agent would. */
export async function createAgentCsr(
  options: { commonName?: string; extensions?: x509.Extension[] } = {},
): Promise<KeyAndCsr> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);

  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${options.commonName ?? 'dockplane-agent'}`,
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    extensions: options.extensions,
  });

  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keys.privateKey);
  const { createPrivateKey } = await import('node:crypto');

  return {
    csrPem: csr.toString('pem'),
    privateKeyPem: createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })
      .export({ format: 'pem', type: 'pkcs8' })
      .toString(),
    publicKey: keys.publicKey,
  };
}

/** An authority the gateway does not trust, used to prove foreign certs fail. */
export async function createForeignAgentCertificate(agentId = 'foreign-agent'): Promise<{
  certificatePem: string;
  privateKeyPem: string;
}> {
  const foreignCa = await createCertificateAuthority('Unrelated CA', YEAR);
  const { AgentCertificateAuthority } = await import('../src/agents/pki');
  const authority = await AgentCertificateAuthority.load(foreignCa);

  const { csrPem, privateKeyPem } = await createAgentCsr();
  const issued = await authority.issueAgentCertificate(csrPem, agentId, 3600);

  return { certificatePem: issued.certificatePem, privateKeyPem };
}
