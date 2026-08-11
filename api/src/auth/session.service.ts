import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';

import { AppConfig } from '../config/configuration';
import { Database } from '../database/database';
import { sessions, users } from '../database/schema';
import { generateSecret, hashSecret, secretsEqual } from '../common/crypto';

export interface IssuedSession {
  readonly sessionId: string;
  /** Returned once, to be placed in the cookie. Never persisted. */
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

export interface ActiveSession {
  readonly id: string;
  readonly userId: string;
  readonly mfaPending: boolean;
  readonly csrfTokenHash: string;
  readonly expiresAt: Date;
}

export interface SessionContext {
  readonly userAgent?: string;
  readonly sourceIp?: string;
}

/**
 * Server-side session store.
 *
 * The browser holds an opaque random token; the database holds only its
 * digest. A database disclosure therefore does not yield usable session
 * cookies, and revocation is immediate because every request resolves the
 * session by digest rather than trusting a self-contained token.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  async issue(
    userId: string,
    options: { mfaPending: boolean } & SessionContext,
  ): Promise<IssuedSession> {
    const token = generateSecret();
    const csrfToken = generateSecret();
    const expiresAt = new Date(Date.now() + this.config.SESSION_TTL * 1000);

    const [created] = await this.db.client
      .insert(sessions)
      .values({
        userId,
        tokenHash: hashSecret(token),
        csrfTokenHash: hashSecret(csrfToken),
        mfaPending: options.mfaPending,
        userAgent: options.userAgent?.slice(0, 256),
        sourceIp: options.sourceIp,
        expiresAt,
      })
      .returning({ id: sessions.id });

    return { sessionId: created.id, token, csrfToken, expiresAt };
  }

  /**
   * Resolves a raw cookie token to an active session.
   *
   * Returns undefined for anything that is not currently usable — unknown,
   * expired, idle-expired, revoked, or belonging to a deactivated user — so a
   * caller cannot accidentally treat a dead session as live.
   */
  async resolve(token: string): Promise<ActiveSession | undefined> {
    const now = new Date();

    const [row] = await this.db.client
      .select({
        id: sessions.id,
        userId: sessions.userId,
        mfaPending: sessions.mfaPending,
        csrfTokenHash: sessions.csrfTokenHash,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
        lastSeenAt: sessions.lastSeenAt,
        userActive: users.isActive,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, hashSecret(token)))
      .limit(1);

    if (!row || row.revokedAt || !row.userActive || row.expiresAt <= now) {
      return undefined;
    }

    const idleDeadline = new Date(
      row.lastSeenAt.getTime() + this.config.SESSION_IDLE_TIMEOUT * 1000,
    );

    if (idleDeadline <= now) {
      await this.revoke(row.id);
      return undefined;
    }

    await this.db.client.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.id));

    return {
      id: row.id,
      userId: row.userId,
      mfaPending: row.mfaPending,
      csrfTokenHash: row.csrfTokenHash,
      expiresAt: row.expiresAt,
    };
  }

  /**
   * Whether a session is still usable, without touching its idle clock.
   *
   * A long-running stream re-checks its session while it runs, and doing that
   * through `resolve` would keep the session alive by observing it: an operator
   * who left a log open would never be signed out for being idle.
   */
  async isActive(sessionId: string): Promise<boolean> {
    const now = new Date();

    const [row] = await this.db.client
      .select({
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
        lastSeenAt: sessions.lastSeenAt,
        userActive: users.isActive,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (!row || row.revokedAt || !row.userActive || row.expiresAt <= now) {
      return false;
    }

    const idleDeadline = new Date(
      row.lastSeenAt.getTime() + this.config.SESSION_IDLE_TIMEOUT * 1000,
    );

    return idleDeadline > now;
  }

  /**
   * Issues a fresh CSRF token for an existing session.
   *
   * Only the digest of a token is stored, so a session that is restored in a
   * new page load cannot be given back the value it was issued at sign-in. It
   * is given a new one instead: without it the browser holds a valid session it
   * is unable to act with, and every state-changing request is refused.
   *
   * The previous token stops working, which is the intended trade. A second tab
   * that has not reloaded will have to, and that is preferable to a session
   * that can read but never write.
   */
  async issueCsrfToken(sessionId: string): Promise<string> {
    const csrfToken = generateSecret();

    await this.db.client
      .update(sessions)
      .set({ csrfTokenHash: hashSecret(csrfToken) })
      .where(eq(sessions.id, sessionId));

    return csrfToken;
  }

  verifyCsrf(session: ActiveSession, presented: string | undefined): boolean {
    return (
      typeof presented === 'string' && secretsEqual(session.csrfTokenHash, hashSecret(presented))
    );
  }

  /**
   * Replaces the session identifier after the second factor succeeds.
   *
   * Rotating on privilege elevation means a token captured during the
   * half-authenticated window cannot be used against the elevated session.
   */
  async completeMfa(sessionId: string, context: SessionContext): Promise<IssuedSession> {
    const [previous] = await this.db.client
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (!previous) {
      throw new Error('Session no longer exists');
    }

    return this.db.client.transaction(async (tx) => {
      await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));

      const token = generateSecret();
      const csrfToken = generateSecret();
      const expiresAt = new Date(Date.now() + this.config.SESSION_TTL * 1000);

      const [created] = await tx
        .insert(sessions)
        .values({
          userId: previous.userId,
          tokenHash: hashSecret(token),
          csrfTokenHash: hashSecret(csrfToken),
          mfaPending: false,
          userAgent: context.userAgent?.slice(0, 256),
          sourceIp: context.sourceIp,
          expiresAt,
        })
        .returning({ id: sessions.id });

      return { sessionId: created.id, token, csrfToken, expiresAt };
    });
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.client
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }

  /** Revokes every active session of a user, optionally sparing the current one. */
  async revokeAllForUser(userId: string, except?: string): Promise<number> {
    const rows = await this.db.client
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          except ? ne(sessions.id, except) : undefined,
        ),
      )
      .returning({ id: sessions.id });

    return rows.length;
  }

  async listForUser(userId: string) {
    return this.db.client
      .select({
        id: sessions.id,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
        userAgent: sessions.userAgent,
        sourceIp: sessions.sourceIp,
      })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.lastSeenAt));
  }

  async findById(sessionId: string) {
    const [row] = await this.db.client
      .select({ id: sessions.id, userId: sessions.userId, revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    return row;
  }
}
