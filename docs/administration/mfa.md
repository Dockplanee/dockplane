# Multi-Factor Authentication

Dockplane supports TOTP as a second factor for local accounts.

## Enabling

```text
POST /api/v1/mfa/setup      returns the secret once
POST /api/v1/mfa/confirm    activates the factor and returns recovery codes once
```

Setup alone changes nothing. The factor becomes active only once a valid code
proves the operator can actually generate one, so a half-finished setup cannot
lock an account out.

The secret is stored encrypted with AES-256-GCM under
`APPLICATION_ENCRYPTION_KEY`. It has to be readable to verify a code, which is
why it is encrypted rather than hashed, and why the key is held outside the
database.

## Recovery codes

Confirmation returns ten single-use recovery codes. They are displayed once and
stored only as digests, so they cannot be recovered later — an operator who
loses them regenerates the set.

```text
POST /api/v1/mfa/recovery-codes/regenerate
```

Regeneration requires a current code and invalidates every previously issued
one.

## Signing in

With the factor enabled, a password sign-in answers `mfa_required` and issues a
session that can reach only the second-factor endpoint:

```text
POST /api/v1/auth/mfa/verify
```

A valid TOTP or an unused recovery code completes the sign-in. The session is
then replaced with a new one.

## Disabling

```text
POST /api/v1/mfa/disable
```

Disabling requires a current code, so a borrowed session cannot quietly weaken
an account. Every session of that user is revoked afterwards, and the secret and
remaining recovery codes are deleted.

## Auditing

Enabling, disabling, recovery-code use, recovery-code regeneration and failed
challenges are all recorded. Secrets and codes never appear in the audit log or
in application logs.
