import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/**
 * Cryptographic primitives shared by the security-sensitive services.
 *
 * Everything here is built on maintained implementations; nothing invents a
 * primitive. The distinction between the three kinds of secret handling is
 * deliberate:
 *
 *   passwords          slow, salted hashing (Argon2id) — never reversible
 *   bearer secrets     fast keyed digest (SHA-256) — high entropy, looked up
 *   stored secrets     authenticated encryption (AES-256-GCM) — recoverable
 */

/** 256 bits, matching the enrollment-token entropy requirement. */
const TOKEN_BYTES = 32;

const ARGON2_OPTIONS = {
  // OWASP-recommended second option: 19 MiB memory, 2 iterations, 1 lane.
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password);
  } catch {
    // A malformed stored hash must not distinguish itself from a wrong password.
    return false;
  }
}

/** URL-safe random secret with at least 256 bits of entropy. */
export function generateSecret(bytes: number = TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Digest for high-entropy bearer secrets such as session and enrollment tokens.
 *
 * A plain digest is appropriate here and a slow hash is not: the input is
 * random 256-bit material, so it cannot be guessed, and lookups happen on every
 * authenticated request.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time comparison for values that may be attacker-controlled. */
export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');

    if (this.key.length !== 32) {
      throw new Error('Encryption key must be 32 bytes');
    }
  }

  /** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(envelope: string): string {
    const [version, iv, tag, ciphertext] = envelope.split('.');

    if (version !== 'v1' || !iv || !tag || !ciphertext) {
      throw new Error('Malformed ciphertext envelope');
    }

    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
