import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { AppError } from '../common/errors';
import { hashPassword, verifyPassword } from '../common/crypto';
import { Database } from '../database/database';
import { users } from '../database/schema';
import { AuditService } from '../audit/audit.service';
import { MfaService } from '../mfa/mfa.service';
import { IssuedSession, SessionContext, SessionService } from './session.service';

export type LoginOutcome =
  | { kind: 'authenticated'; session: IssuedSession; userId: string }
  | { kind: 'mfa-required'; session: IssuedSession; userId: string };

/**
 * Local authentication.
 *
 * Every rejected sign-in answers identically. An unknown address, a wrong
 * password and a deactivated account are indistinguishable to the caller, and a
 * password verification runs even when no user matched, so response timing does
 * not reveal whether the address exists.
 */
@Injectable()
export class AuthService {
  /** Verified against a discarded hash so an unknown address costs the same work. */
  private decoyHash?: Promise<string>;

  constructor(
    private readonly db: Database,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, context: SessionContext): Promise<LoginOutcome> {
    const [user] = await this.db.client
      .select({
        id: users.id,
        email: users.email,
        passwordHash: users.passwordHash,
        isActive: users.isActive,
        mfaEnabled: users.mfaEnabled,
      })
      .from(users)
      .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()))
      .limit(1);

    const passwordMatches = user
      ? await verifyPassword(user.passwordHash, password)
      : await this.burnTime(password);

    if (!user || !passwordMatches || !user.isActive) {
      await this.audit.record({
        action: 'auth.login.failed',
        result: 'failure',
        actorUserId: user?.id,
        actorLabel: user ? user.email : 'unknown',
        targetType: 'user',
        targetId: user?.id,
        reasonCode: !user
          ? 'unknown_account'
          : !passwordMatches
            ? 'invalid_password'
            : 'account_inactive',
        sourceIp: context.sourceIp,
        userAgent: context.userAgent,
      });

      throw AppError.unauthorized(
        'AUTH_INVALID_CREDENTIALS',
        'The email address or password is not correct.',
      );
    }

    const session = await this.sessions.issue(user.id, {
      mfaPending: user.mfaEnabled,
      ...context,
    });

    if (user.mfaEnabled) {
      return { kind: 'mfa-required', session, userId: user.id };
    }

    await this.completeLogin(user.id, user.email, context);

    return { kind: 'authenticated', session, userId: user.id };
  }

  /**
   * Completes a sign-in that required a second factor.
   *
   * The session identifier is rotated, so the token held during the pending
   * window cannot be used against the now-privileged session.
   */
  async verifyMfa(
    sessionId: string,
    userId: string,
    code: string,
    context: SessionContext,
  ): Promise<IssuedSession> {
    const [user] = await this.db.client
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const result = await this.mfa.verifyChallenge(userId, code);

    if (!result.accepted) {
      await this.audit.record({
        action: 'auth.mfa.challenge.failed',
        result: 'failure',
        actorUserId: userId,
        actorLabel: user?.email ?? userId,
        targetType: 'user',
        targetId: userId,
        reasonCode: 'invalid_code',
        sourceIp: context.sourceIp,
        userAgent: context.userAgent,
      });

      throw AppError.unauthorized('AUTH_MFA_INVALID', 'That code is not valid.');
    }

    if (result.usedRecoveryCode) {
      await this.audit.record({
        action: 'mfa.recovery_code.used',
        result: 'success',
        actorUserId: userId,
        actorLabel: user?.email ?? userId,
        targetType: 'user',
        targetId: userId,
        sourceIp: context.sourceIp,
        userAgent: context.userAgent,
      });
    }

    const rotated = await this.sessions.completeMfa(sessionId, context);
    await this.completeLogin(userId, user?.email ?? userId, context);

    return rotated;
  }

  async logout(
    sessionId: string,
    userId: string,
    email: string,
    context: SessionContext,
  ): Promise<void> {
    await this.sessions.revoke(sessionId);

    await this.audit.record({
      action: 'auth.logout',
      result: 'success',
      actorUserId: userId,
      actorLabel: email,
      targetType: 'session',
      targetId: sessionId,
      sourceIp: context.sourceIp,
      userAgent: context.userAgent,
    });
  }

  private async completeLogin(
    userId: string,
    email: string,
    context: SessionContext,
  ): Promise<void> {
    await this.db.client.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));

    await this.audit.record({
      action: 'auth.login.succeeded',
      result: 'success',
      actorUserId: userId,
      actorLabel: email,
      targetType: 'user',
      targetId: userId,
      sourceIp: context.sourceIp,
      userAgent: context.userAgent,
    });
  }

  private async burnTime(password: string): Promise<false> {
    this.decoyHash ??= hashPassword('dockplane-timing-equaliser');
    await verifyPassword(await this.decoyHash, password);

    return false;
  }
}
