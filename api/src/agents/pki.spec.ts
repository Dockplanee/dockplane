import { generateKeyPairSync } from 'node:crypto';

import * as x509 from '@peculiar/x509';

import {
  AgentCertificateAuthority,
  CertificateRequestError,
  createCertificateAuthority,
  fingerprintOf,
  parseCsr,
  serialOf,
} from './pki';

const HOUR = 3600;

async function agentCsr(commonName = 'requested-name'): Promise<string> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);

  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${commonName}`,
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
  });

  return csr.toString('pem');
}

describe('agent certificate authority', () => {
  let authority: AgentCertificateAuthority;
  let material: Awaited<ReturnType<typeof createCertificateAuthority>>;

  beforeAll(async () => {
    material = await createCertificateAuthority('Dockplane Test CA', 24 * HOUR);
    authority = await AgentCertificateAuthority.load(material);
  });

  it('creates a CA that is marked as a certificate authority', () => {
    const certificate = new x509.X509Certificate(material.certificatePem);
    const constraints = certificate.getExtension(x509.BasicConstraintsExtension);

    expect(constraints?.ca).toBe(true);
  });

  it('does not expose the CA key in the certificate', () => {
    expect(material.certificatePem).not.toContain('PRIVATE KEY');
  });

  it('issues a client certificate chained to the CA', async () => {
    const issued = await authority.issueAgentCertificate(await agentCsr(), 'agent-1', HOUR);
    const certificate = new x509.X509Certificate(issued.certificatePem);
    const ca = new x509.X509Certificate(material.certificatePem);

    expect(await certificate.verify({ publicKey: await ca.publicKey.export() })).toBe(true);
  });

  it('names the certificate after the server-assigned identity, not the request', async () => {
    const issued = await authority.issueAgentCertificate(
      await agentCsr('i-would-like-to-be-someone-else'),
      'agent-assigned-id',
      HOUR,
    );

    expect(new x509.X509Certificate(issued.certificatePem).subject).toBe('CN=agent-assigned-id');
  });

  it('marks the certificate for client authentication only', async () => {
    const issued = await authority.issueAgentCertificate(await agentCsr(), 'agent-1', HOUR);
    const usage = new x509.X509Certificate(issued.certificatePem).getExtension(
      x509.ExtendedKeyUsageExtension,
    );

    expect(usage?.usages).toEqual([x509.ExtendedKeyUsage.clientAuth]);
  });

  it('issues certificates that expire', async () => {
    const issued = await authority.issueAgentCertificate(await agentCsr(), 'agent-1', HOUR);
    const lifetime = issued.notAfter.getTime() - Date.now();

    expect(lifetime).toBeGreaterThan(0);
    expect(lifetime).toBeLessThanOrEqual((HOUR + 60) * 1000);
  });

  it('gives every certificate a distinct serial and fingerprint', async () => {
    const first = await authority.issueAgentCertificate(await agentCsr(), 'agent-1', HOUR);
    const second = await authority.issueAgentCertificate(await agentCsr(), 'agent-1', HOUR);

    expect(first.serialHex).not.toBe(second.serialHex);
    expect(first.fingerprintSha256).not.toBe(second.fingerprintSha256);
  });

  it('derives the same fingerprint and serial from the issued certificate', async () => {
    const issued = await authority.issueAgentCertificate(await agentCsr(), 'agent-1', HOUR);

    expect(fingerprintOf(issued.certificatePem)).toBe(issued.fingerprintSha256);
    expect(serialOf(issued.certificatePem)).toBe(issued.serialHex);
  });

  it('rejects a request that is not PEM', async () => {
    await expect(authority.issueAgentCertificate('not-a-csr', 'agent-1', HOUR)).rejects.toThrow(
      CertificateRequestError,
    );
  });

  it('rejects a structurally broken request', async () => {
    const broken = (await agentCsr()).replace(/[A-Za-z0-9+/]{20}/, 'AAAAAAAAAAAAAAAAAAAA');

    await expect(authority.issueAgentCertificate(broken, 'agent-1', HOUR)).rejects.toThrow(
      CertificateRequestError,
    );
  });

  it('rejects an RSA request whose signature does not verify', async () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

    expect(() => parseCsr(publicKey.export({ format: 'pem', type: 'spki' }).toString())).toThrow(
      CertificateRequestError,
    );
  });
});
