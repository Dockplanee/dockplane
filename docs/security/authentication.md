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

## Multi-factor authentication

Dockplane supports TOTP as a second factor for local accounts.

```text
POST /api/v1/mfa/setup      returns the secret once
POST /api/v1/mfa/confirm    activates the factor and returns recovery codes once
```

Setup alone changes nothing. The factor becomes active only once a valid code
proves the operator can actually generate one, so a half-finished setup cannot
lock an account out.

The secret is encrypted with AES-256-GCM under `APPLICATION_ENCRYPTION_KEY`. It
has to be readable to verify a code, which is why it is encrypted rather than
hashed, and why the key is held outside the database.

### Recovery codes

Confirmation returns ten single-use recovery codes, displayed once and stored
only as digests. They cannot be recovered later; an operator who loses them
regenerates the set.

```text
POST /api/v1/mfa/recovery-codes/regenerate
```

Regeneration requires a current code and invalidates every previously issued
one.

### Signing in with a second factor

With the factor enabled, a password sign-in answers `mfa_required` and issues a
session that can reach only the second-factor endpoint:

```text
POST /api/v1/auth/mfa/verify
```

A valid TOTP or an unused recovery code completes the sign-in, and the session
is replaced with a new one.

### Disabling

```text
POST /api/v1/mfa/disable
```

Disabling requires a current code, so a borrowed session cannot quietly weaken
an account. Every session of that user is revoked afterwards, and the secret and
remaining recovery codes are deleted.

## Authorization

Authorization is enforced by the control server. What the interface shows is a
convenience; it is never the access boundary.

Each protected route declares the permissions it requires, and a single guard
evaluates that declaration. There is no role-name check scattered through
handlers and no administrator fallback.

Authorization fails closed. A route with a declared requirement is refused when
there is no authenticated user, when the permission set is empty, or when a
required permission is missing.

### Permission catalog

A permission exists only when the control server actually enforces something
with it:

```text
hosts.read          view Docker hosts and their reported state
containers.read     view discovered containers
containers.start    start a container
containers.stop     stop a container
containers.restart  restart a container
containers.logs     read and follow container output
containers.create   create a container
containers.update   change a container's configuration, which recreates it
containers.delete   remove a container
compose.read        view discovered Compose projects
stacks.read         view stacks and their revisions
stacks.create       create a stack
stacks.update       change a stack's Compose source or environment
stacks.deploy       deploy, redeploy, start, stop or restart a stack
stacks.delete       remove a stack
agents.read         view enrolled agents
agents.enroll       create agent enrollment tokens
agents.revoke       revoke an agent credential
audit.read          read the audit log
users.read          view users
users.manage        create, modify and deactivate users, and assign roles
roles.read          view roles and their permissions
sessions.read       view sessions of other accounts
sessions.revoke     revoke sessions of other accounts
```

The three lifecycle keys are deliberately separate. A single
`containers.manage` would be easier to grant and impossible to grant carefully:
an operator who should be able to restart a stuck service would also be able to
stop one for good.

`containers.logs` is sensitive in a way the others are not. Dockplane cannot
know what an application prints, and applications print passwords, tokens and
personal data. Granting it grants whatever the workloads on a host happen to
write, so it is granted deliberately rather than bundled with being able to see
that a container exists.

### Built-in roles

```text
Administrator   the full catalog
Operator        hosts, containers, Compose, agents, the audit log, restart, logs
Read Only       hosts, containers and Compose
```

Operator carries `containers.restart` but neither `containers.stop` nor
`containers.start`. Restarting a stuck service is day-to-day work; taking one
down and leaving it down is a decision with a different weight. Whoever needs
both gets both, by a deliberate grant rather than by inheriting it.

Built-in roles are defined in code and reconciled by every migration run, so a
release that adds a permission does not need a hand-written data migration.

```text
GET  /api/v1/users             requires users.read
POST /api/v1/users/:id/roles   requires users.manage
GET  /api/v1/roles             requires roles.read
```

## Audit

Security-relevant and infrastructure-changing events are recorded with the
actor, the action, the target, the result, a timestamp and the request
correlation ID.

Sign-ins and failures, second-factor enabling and disabling, recovery-code use
and regeneration, role assignment, agent enrollment and revocation, and every
container lifecycle action are all audited. Reading the log requires
`audit.read`.

Secrets never appear in it: no passwords, no tokens, no second-factor secrets,
no recovery codes. **Container output is not audited either** — the audit log
records that somebody read a container's logs, not what those logs said.

## Related

- [Security Model](security-model.md)
- [Agent Security](agent-security.md)
