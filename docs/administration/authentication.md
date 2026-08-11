# Authentication

Dockplane authenticates operators against local accounts and keeps session state
on the server.

## Passwords

Passwords are hashed with Argon2id. The stored value is a hash and cannot be
reversed, so a database disclosure does not yield passwords. Long passphrases
are supported; a submitted password is never written to a log.

## Sessions

A sign-in issues an opaque, cryptographically random token.

- The raw token exists only in the browser cookie.
- The database stores only its SHA-256 digest.
- Every request resolves the session by digest.

A database copy therefore contains nothing that can be replayed as a cookie, and
revoking a session takes effect on the next request rather than when a token
happens to expire.

The cookie is set `HttpOnly`, `SameSite=Lax`, scoped to `/`, and `Secure` unless
the development switch is enabled.

A session stops being accepted when any of the following is true:

- it passed `SESSION_TTL`
- it was idle longer than `SESSION_IDLE_TIMEOUT`
- it was revoked
- the account was deactivated

### Rotation

Completing a second-factor challenge issues a new session and revokes the
previous one. A token captured while the session was only half-authenticated is
therefore useless against the elevated session.

## CSRF

State-changing requests that authenticate with a cookie are protected by two
independent checks:

- the `Origin` (or `Referer`) must match `PUBLIC_APP_URL`
- the `X-CSRF-Token` header must match the token bound to the session

The CSRF token is returned by the login response, including the response that
signals a second factor is still required.

CORS is not a CSRF defence. A browser sends a cross-site form post regardless of
CORS, and the response being unreadable does not undo the state change.

## Abuse control

The login and second-factor endpoints are rate limited on a sliding window,
counted per source address and, where an account is named, per account. Nothing
is locked permanently: a persistent lockout would let anyone deny a colleague
access by guessing their password badly on purpose.

## Sign-in failures

Every rejected sign-in answers identically. An unknown address, a wrong password
and a deactivated account produce the same status and the same error code, and a
password verification runs even when no account matched so response timing does
not reveal whether an address exists.

The audit log records the distinction internally with a reason code.

## Sessions API

```text
GET    /api/v1/sessions        the caller's sessions; the current one is marked
DELETE /api/v1/sessions/:id    revoke a session
```

An operator can always list and revoke their own sessions. Reaching another
account requires `sessions.read` or `sessions.revoke`.

Session metadata contains the creation time, last activity, expiry, user agent
and source address. It never contains a token or a digest.
