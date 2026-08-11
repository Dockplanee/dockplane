import {
  SecretBox,
  generateSecret,
  hashPassword,
  hashSecret,
  secretsEqual,
  verifyPassword,
} from './crypto';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(await verifyPassword(hash, 'Correct horse battery staple')).toBe(false);
  });

  it('never stores the password in the hash', async () => {
    const password = 'a-very-distinctive-passphrase';
    const hash = await hashPassword(password);

    expect(hash).not.toContain(password);
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('produces a different hash for the same password', async () => {
    const [first, second] = await Promise.all([hashPassword('same'), hashPassword('same')]);

    expect(first).not.toBe(second);
  });

  it('accepts long passphrases', async () => {
    const passphrase = 'x'.repeat(512);

    expect(await verifyPassword(await hashPassword(passphrase), passphrase)).toBe(true);
  });

  it('treats a malformed stored hash as a failed verification', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});

describe('bearer secrets', () => {
  it('generates at least 256 bits of entropy', () => {
    const secret = generateSecret();

    expect(Buffer.from(secret, 'base64url').length).toBeGreaterThanOrEqual(32);
  });

  it('does not repeat', () => {
    const secrets = new Set(Array.from({ length: 200 }, () => generateSecret()));

    expect(secrets.size).toBe(200);
  });

  it('hashes deterministically without revealing the secret', () => {
    const secret = generateSecret();
    const digest = hashSecret(secret);

    expect(digest).toBe(hashSecret(secret));
    expect(digest).not.toContain(secret);
    expect(digest).toHaveLength(64);
  });

  it('compares without leaking length-independent equality', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true);
    expect(secretsEqual('abc', 'abd')).toBe(false);
    expect(secretsEqual('abc', 'abcd')).toBe(false);
  });
});

describe('SecretBox', () => {
  const key = Buffer.alloc(32, 7).toString('base64');

  it('round-trips a value', () => {
    const box = new SecretBox(key);
    const envelope = box.encrypt('JBSWY3DPEHPK3PXP');

    expect(box.decrypt(envelope)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('never emits the plaintext', () => {
    const box = new SecretBox(key);

    expect(box.encrypt('JBSWY3DPEHPK3PXP')).not.toContain('JBSWY3DPEHPK3PXP');
  });

  it('produces a different envelope every time', () => {
    const box = new SecretBox(key);

    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('rejects a tampered ciphertext', () => {
    const box = new SecretBox(key);
    const [version, iv, tag, ciphertext] = box.encrypt('secret').split('.');
    const flipped = Buffer.from(ciphertext, 'base64url');
    flipped[0] ^= 0xff;

    expect(() =>
      box.decrypt([version, iv, tag, flipped.toString('base64url')].join('.')),
    ).toThrow();
  });

  it('rejects a value encrypted under a different key', () => {
    const envelope = new SecretBox(key).encrypt('secret');
    const other = new SecretBox(Buffer.alloc(32, 9).toString('base64'));

    expect(() => other.decrypt(envelope)).toThrow();
  });

  it('refuses a key of the wrong length', () => {
    expect(() => new SecretBox(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
