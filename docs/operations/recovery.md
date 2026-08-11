# Recovery

Three things must survive a control-server loss, and they are deliberately kept
apart. A backup of only one of them is not a backup.

## PostgreSQL

Holds users, roles, sessions, the agent registry and the audit trail. Restore it
with the ordinary tooling for your deployment.

## Application encryption material

`APPLICATION_ENCRYPTION_KEY` protects MFA secrets at rest and is deliberately
not derived from the database, so a copy of the database alone cannot decrypt
them. Store it separately from the database backup.

Losing it means every enrolled second factor has to be set up again. Recovery
codes do not help: they are stored as hashes and are unlocked by the same
material.

## Agent certificate authority

The CA certificate and key sign every agent identity. Back up the directory
named by `AGENT_CA_CERT_PATH` and `AGENT_CA_KEY_PATH`, separately from the
database and restricted to the account the server runs as.

Losing the CA key means re-enrolling every agent. Leaking it is worse: anyone
holding it can mint a certificate for any agent, and the only remedy is a new CA
and a full re-enrollment.

## Administrator recovery

There is no default account and no password reset that bypasses authentication.
If every administrator is locked out, create a new one with `bootstrap:admin`
against the restored database. The command refuses to run while an active
administrator exists.

## Session invalidation

Sessions are server-side records. Deleting them logs everyone out, and a
restored database restores whatever sessions it contained; revoke them
explicitly after a restore if the backup is not recent.

## Agent credential revocation

Revocation is a registry state, so it survives a restore only if the backup is
newer than the revocation. After restoring an older backup, confirm that no
previously revoked agent has become trusted again.

## Control-server host replacement

A replacement host needs the database, the application encryption material and
the CA directory. With all three, enrolled agents reconnect without
re-enrollment, because their identity is anchored in the CA and the registry
rather than in the host.

## Managed host replacement

Nothing on a Docker host needs backing up. Its identity is a credential the
control server issued and can issue again: enroll the replacement and revoke the
old agent. The `/var/lib/dockplane-agent` directory is state, not data — copying
it to another machine would give two hosts the same identity, which is exactly
what per-agent credentials exist to prevent.

Discovered inventory is a cache of what a host reported. It is rebuilt on the
next discovery pass and is not something to restore.
