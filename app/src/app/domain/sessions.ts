/**
 * An operator's server-side session.
 *
 * The session token never reaches the browser as a value: it lives in an
 * HttpOnly cookie, and this record is metadata about it.
 */
export interface OperatorSession {
  readonly id: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly userAgent?: string;
  readonly sourceIp?: string;
  /** True for the session this browser is using. */
  readonly current: boolean;
}
