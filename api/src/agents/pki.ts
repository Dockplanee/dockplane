import { createHash, createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';

import * as x509 from '@peculiar/x509';

/**
 * Certificate authority for agent identities.
 *
 * The agent CA is the root of device trust: anything it signs can connect to
 * the gateway. Its private key therefore never enters the database and never
 * enters a log line — it is read from a protected file, held only in memory,
 * and used solely to sign certificate requests.
 *
 * Certificates are ECDSA P-256, which every maintained TLS stack supports and
 * which keeps agent handshakes cheap.
 */

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNING = { name: 'ECDSA', hash: 'SHA-256' } as const;

export interface IssuedCertificate {
  readonly certificatePem: string;
  readonly serialHex: string;
  readonly fingerprintSha256: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

export interface CertificateAuthorityMaterial {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  /** Set when the key on disk is stored encrypted. */
  readonly passphrase?: string;
}

function toCryptoKey(key: KeyObject, usages: KeyUsage[]): Promise<CryptoKey> {
  const jwk = key.export({ format: 'jwk' }) as JsonWebKey;
  return crypto.subtle.importKey('jwk', jwk, ALGORITHM, true, usages);
}

/** SHA-256 over the DER encoding, the same value the gateway derives from a peer certificate. */
export function fingerprintOf(certificatePem: string): string {
  const certificate = new x509.X509Certificate(certificatePem);
  return createHash('sha256').update(Buffer.from(certificate.rawData)).digest('hex');
}

export function serialOf(certificatePem: string): string {
  return new x509.X509Certificate(certificatePem).serialNumber.toLowerCase();
}

export function notAfterOf(certificatePem: string): Date {
  return new x509.X509Certificate(certificatePem).notAfter;
}

/**
 * Creates a self-signed agent CA.
 *
 * Used by the explicit setup command only. Nothing generates a CA implicitly:
 * a control server that silently minted a new CA on restart would invalidate
 * every enrolled agent and quietly widen the trust boundary.
 */
export async function createCertificateAuthority(
  commonName: string,
  lifetimeSeconds: number,
): Promise<CertificateAuthorityMaterial> {
  const keys = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);

  const now = new Date();
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name: `CN=${commonName}`,
    notBefore: new Date(now.getTime() - 60_000),
    notAfter: new Date(now.getTime() + lifetimeSeconds * 1000),
    keys,
    signingAlgorithm: SIGNING,
    extensions: [
      new x509.BasicConstraintsExtension(true, 1, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });

  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keys.privateKey);

  return {
    certificatePem: certificate.toString('pem'),
    privateKeyPem: createPrivateKey({
      key: Buffer.from(pkcs8),
      format: 'der',
      type: 'pkcs8',
    })
      .export({ format: 'pem', type: 'pkcs8' })
      .toString(),
  };
}

export class AgentCertificateAuthority {
  private constructor(
    private readonly caCert: x509.X509Certificate,
    private readonly signingKey: CryptoKey,
    readonly certificatePem: string,
  ) {}

  static async load(material: CertificateAuthorityMaterial): Promise<AgentCertificateAuthority> {
    const caCert = new x509.X509Certificate(material.certificatePem);
    const privateKey = createPrivateKey(
      material.passphrase
        ? { key: material.privateKeyPem, passphrase: material.passphrase }
        : material.privateKeyPem,
    );

    return new AgentCertificateAuthority(
      caCert,
      await toCryptoKey(privateKey, ['sign']),
      material.certificatePem,
    );
  }

  /**
   * Signs an agent certificate request.
   *
   * The subject is taken from the control server's own record, never from the
   * request: an agent that asks to be someone else is simply issued a
   * certificate for the identity the server assigned it.
   */
  async issueAgentCertificate(
    csrPem: string,
    agentId: string,
    lifetimeSeconds: number,
  ): Promise<IssuedCertificate> {
    const csr = parseCsr(csrPem);

    if (!(await csr.verify())) {
      throw new CertificateRequestError('The certificate request signature is not valid.');
    }

    const publicKey = await csr.publicKey.export();
    const now = new Date();
    const notBefore = new Date(now.getTime() - 60_000);
    const notAfter = new Date(now.getTime() + lifetimeSeconds * 1000);

    const certificate = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: `CN=${agentId}`,
      issuer: this.caCert.subject,
      notBefore,
      notAfter,
      publicKey,
      signingKey: this.signingKey,
      signingAlgorithm: SIGNING,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
          true,
        ),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], true),
        await x509.SubjectKeyIdentifierExtension.create(publicKey),
        await x509.AuthorityKeyIdentifierExtension.create(this.caCert),
      ],
    });

    const certificatePem = certificate.toString('pem');

    return {
      certificatePem,
      serialHex: certificate.serialNumber.toLowerCase(),
      fingerprintSha256: createHash('sha256')
        .update(Buffer.from(certificate.rawData))
        .digest('hex'),
      notBefore,
      notAfter,
    };
  }

  /** Issues the gateway's own TLS certificate so agents can authenticate the server. */
  async issueServerCertificate(
    publicKey: CryptoKey,
    hostnames: readonly string[],
    lifetimeSeconds: number,
  ): Promise<string> {
    const isIp = (value: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':');
    const dns = hostnames.filter((entry) => !isIp(entry));
    const ip = hostnames.filter(isIp);
    const now = new Date();

    const certificate = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: `CN=${hostnames[0]}`,
      issuer: this.caCert.subject,
      notBefore: new Date(now.getTime() - 60_000),
      notAfter: new Date(now.getTime() + lifetimeSeconds * 1000),
      publicKey,
      signingKey: this.signingKey,
      signingAlgorithm: SIGNING,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
          true,
        ),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], true),
        new x509.SubjectAlternativeNameExtension([
          ...dns.map((value) => ({ type: 'dns' as const, value })),
          ...ip.map((value) => ({ type: 'ip' as const, value })),
        ]),
        await x509.SubjectKeyIdentifierExtension.create(publicKey),
        await x509.AuthorityKeyIdentifierExtension.create(this.caCert),
      ],
    });

    return certificate.toString('pem');
  }
}

export class CertificateRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertificateRequestError';
  }
}

/** Largest request accepted, so parsing cannot be used to exhaust memory. */
const MAX_CSR_BYTES = 8192;

const ACCEPTED_CURVES = new Set(['P-256', 'P-384', 'P-521']);
const MINIMUM_RSA_BITS = 2048;

/**
 * Extensions a request may not carry.
 *
 * A certificate request is a proposal, not an instruction. Anything that could
 * widen what the issued certificate is trusted for — turning it into a CA,
 * adding server or code-signing usage, or claiming alternative names — is
 * refused outright rather than silently dropped, so a rejected enrollment is
 * visible instead of quietly downgraded.
 */
const FORBIDDEN_EXTENSIONS = new Map<string, string>([
  ['2.5.29.19', 'basic constraints'],
  ['2.5.29.15', 'key usage'],
  ['2.5.29.37', 'extended key usage'],
  ['2.5.29.17', 'subject alternative names'],
  ['2.5.29.30', 'name constraints'],
  ['2.5.29.36', 'policy constraints'],
  ['2.5.29.32', 'certificate policies'],
]);

/**
 * Parses and validates a certificate request.
 *
 * The request contributes exactly one thing: a public key. Subject, usages and
 * lifetime all come from the control server, so a manipulated request cannot
 * obtain a different identity or broader authority.
 */
export function parseCsr(csrPem: string): x509.Pkcs10CertificateRequest {
  if (typeof csrPem !== 'string' || !csrPem.includes('CERTIFICATE REQUEST')) {
    throw new CertificateRequestError('A PEM certificate request is required.');
  }

  if (Buffer.byteLength(csrPem, 'utf8') > MAX_CSR_BYTES) {
    throw new CertificateRequestError('The certificate request is too large.');
  }

  let csr: x509.Pkcs10CertificateRequest;

  try {
    csr = new x509.Pkcs10CertificateRequest(csrPem);
  } catch {
    // The parser message is not echoed: this endpoint is unauthenticated.
    throw new CertificateRequestError('The certificate request could not be parsed.');
  }

  assertAcceptableKey(csr);
  assertNoForbiddenExtensions(csr);

  return csr;
}

function assertAcceptableKey(csr: x509.Pkcs10CertificateRequest): void {
  let key: KeyObject;

  try {
    key = createPublicKey(csr.publicKey.toString('pem'));
  } catch {
    throw new CertificateRequestError('The certificate request has an unusable public key.');
  }

  const details = key.asymmetricKeyDetails ?? {};

  if (key.asymmetricKeyType === 'ec') {
    // Node reports the curve under its OpenSSL name.
    const curve = { prime256v1: 'P-256', secp384r1: 'P-384', secp521r1: 'P-521' }[
      details.namedCurve ?? ''
    ];

    if (!curve || !ACCEPTED_CURVES.has(curve)) {
      throw new CertificateRequestError('The certificate request uses an unsupported curve.');
    }

    return;
  }

  if (key.asymmetricKeyType === 'rsa') {
    if ((details.modulusLength ?? 0) < MINIMUM_RSA_BITS) {
      throw new CertificateRequestError('The certificate request uses too small an RSA key.');
    }

    return;
  }

  throw new CertificateRequestError('The certificate request uses an unsupported key type.');
}

function assertNoForbiddenExtensions(csr: x509.Pkcs10CertificateRequest): void {
  for (const extension of csr.extensions ?? []) {
    const description = FORBIDDEN_EXTENSIONS.get(extension.type);

    if (description) {
      throw new CertificateRequestError(`The certificate request may not request ${description}.`);
    }
  }
}

function randomSerial(): string {
  // 128 bits, positive, matching common CA practice.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[0] &= 0x7f;
  return Buffer.from(bytes).toString('hex');
}
