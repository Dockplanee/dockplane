import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';

import { AppError } from '../common/errors';
import { SecretBox, generateSecret, hashSecret } from '../common/crypto';
import { SECRET_BOX } from '../config/tokens';
import { Database } from '../database/database';
import { recoveryCodes, users } from '../database/schema';

const ISSUER = 'Dockplane';
const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * One step of clock skew is tolerated in each direction. A wider window would
 * enlarge the guessing surface for every code.
 */
const VALIDATION_WINDOW = 1;

const RECOVERY_CODE_COUNT = 10;
/** 80 bits per code: infeasible to guess, still short enough to transcribe. */
const RECOVERY_CODE_BYTES = 10;

export interface MfaSetup {
  /** Shown once so the operator can add it to an authenticator. */
  readonly secret: string;
  readonly otpauthUrl: string;
}

export interface MfaActivation {
  /** Shown once, in clear, and never recoverable afterwards. */
  readonly recoveryCodes: readonly string[];
}

/**
 * TOTP second factor.
 *
 * The secret must be readable to verify a code, so it is stored encrypted under
 * a key held outside the database rather than hashed. Recovery codes are the
 * opposite: they are only ever compared, so only their digests are kept.
 *
 * Setup does not enable anything. MFA becomes active only once the operator
 * proves possession by returning a valid code, so a half-finished setup cannot
 * lock an account out.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly db: Database,
    @Inject(SECRET_BOX) private readonly secretBox: SecretBox,
  ) {}

  /** Generates a candidate secret and stores it unconfirmed. */
  async beginSetup(userId: string, email: string): Promise<MfaSetup> {
    const secret = new Secret({ size: 20 });

    await this.db.client
      .update(users)
      .set({
        mfaSecretEncrypted: this.secretBox.encrypt(secret.base32),
        mfaEnabled: false,
        mfaConfirmedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    return {
      secret: secret.base32,
      otpauthUrl: this.totp(secret.base32, email).toString(),
    };
  }

  /**
   * Confirms possession and activates the second factor.
   *
   * Returns the recovery codes exactly once; only their digests are stored.
   */
  async confirmSetup(userId: string, code: string): Promise<MfaActivation> {
    const user = await this.requireUser(userId);

    if (!user.mfaSecretEncrypted) {
      throw new AppError('AUTH_MFA_INVALID', 'Start multi-factor setup before confirming it.');
    }

    if (!this.verifyTotp(user.mfaSecretEncrypted, user.email, code)) {
      throw new AppError('AUTH_MFA_INVALID', 'That code is not valid.');
    }

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      generateSecret(RECOVERY_CODE_BYTES),
    );

    await this.db.client.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ mfaEnabled: true, mfaConfirmedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, userId));

      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
      await tx
        .insert(recoveryCodes)
        .values(codes.map((code_) => ({ userId, codeHash: hashSecret(code_) })));
    });

    return { recoveryCodes: codes };
  }

  async disable(userId: string): Promise<void> {
    await this.db.client.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          mfaEnabled: false,
          mfaSecretEncrypted: null,
          mfaConfirmedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    });
  }

  /** Replaces every unused code; previously issued codes stop working. */
  async regenerateRecoveryCodes(userId: string): Promise<MfaActivation> {
    const user = await this.requireUser(userId);

    if (!user.mfaEnabled) {
      throw new AppError('AUTH_MFA_INVALID', 'Multi-factor authentication is not enabled.');
    }

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      generateSecret(RECOVERY_CODE_BYTES),
    );

    await this.db.client.transaction(async (tx) => {
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
      await tx
        .insert(recoveryCodes)
        .values(codes.map((code) => ({ userId, codeHash: hashSecret(code) })));
    });

    return { recoveryCodes: codes };
  }

  async verifyChallenge(
    userId: string,
    code: string,
  ): Promise<{ accepted: boolean; usedRecoveryCode: boolean }> {
    const user = await this.requireUser(userId);

    if (!user.mfaEnabled || !user.mfaSecretEncrypted) {
      return { accepted: false, usedRecoveryCode: false };
    }

    if (this.verifyTotp(user.mfaSecretEncrypted, user.email, code)) {
      return { accepted: true, usedRecoveryCode: false };
    }

    return {
      accepted: await this.consumeRecoveryCode(userId, code),
      usedRecoveryCode: true,
    };
  }

  /**
   * Marks a recovery code as used.
   *
   * The update is conditional on the code still being unconsumed, so two
   * concurrent attempts with the same code cannot both succeed.
   */
  private async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const consumed = await this.db.client
      .update(recoveryCodes)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(recoveryCodes.userId, userId),
          eq(recoveryCodes.codeHash, hashSecret(code.trim())),
          isNull(recoveryCodes.consumedAt),
        ),
      )
      .returning({ id: recoveryCodes.id });

    return consumed.length === 1;
  }

  async remainingRecoveryCodes(userId: string): Promise<number> {
    const rows = await this.db.client
      .select({ id: recoveryCodes.id })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.consumedAt)));

    return rows.length;
  }

  private verifyTotp(encryptedSecret: string, email: string, code: string): boolean {
    const normalized = code.replace(/\s/g, '');

    if (!/^\d{6}$/.test(normalized)) {
      return false;
    }

    const totp = this.totp(this.secretBox.decrypt(encryptedSecret), email);

    return totp.validate({ token: normalized, window: VALIDATION_WINDOW }) !== null;
  }

  private totp(base32Secret: string, email: string): TOTP {
    return new TOTP({
      issuer: ISSUER,
      label: email,
      algorithm: 'SHA1',
      digits: DIGITS,
      period: PERIOD_SECONDS,
      secret: Secret.fromBase32(base32Secret),
    });
  }

  private async requireUser(userId: string) {
    const [user] = await this.db.client
      .select({
        id: users.id,
        email: users.email,
        mfaEnabled: users.mfaEnabled,
        mfaSecretEncrypted: users.mfaSecretEncrypted,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw AppError.notFound('USER_NOT_FOUND', 'The user does not exist.');
    }

    return user;
  }
}
