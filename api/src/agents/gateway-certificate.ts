import { createPrivateKey } from 'node:crypto';

import { AgentCertificateAuthority, CertificateAuthorityMaterial } from './pki';

/**
 * Server certificate for the agent gateway.
 *
 * Agents authenticate the control server before presenting their own
 * certificate, so the gateway needs an identity the agent can pin. Issuing it
 * from the same private CA keeps the deployment self-contained: an operator
 * distributes one CA certificate and both directions of the handshake verify.
 */
export async function createGatewayCertificate(
  ca: CertificateAuthorityMaterial,
  hostnames: readonly string[],
  lifetimeSeconds: number,
): Promise<{ certificatePem: string; privateKeyPem: string }> {
  if (hostnames.length === 0) {
    throw new Error('At least one gateway hostname is required');
  }

  const authority = await AgentCertificateAuthority.load(ca);
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);

  const certificatePem = await authority.issueServerCertificate(
    keys.publicKey,
    hostnames,
    lifetimeSeconds,
  );

  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keys.privateKey);

  return {
    certificatePem,
    privateKeyPem: createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })
      .export({ format: 'pem', type: 'pkcs8' })
      .toString(),
  };
}
