# Security Model

## Trust Boundaries

Dockplane crosses:

1. browser ↔ control server
2. control server ↔ PostgreSQL
3. control server ↔ agent
4. agent ↔ Docker daemon
5. agent ↔ host OS

Each boundary is treated explicitly.

## Agent Enrollment

1. An administrator creates a short-lived enrollment token.
2. The host generates a key pair and sends a certificate request over TLS.
3. The certificate request is validated, then the token is claimed atomically.
4. The internal agent CA issues a client certificate for a server-assigned ID.
5. The token is spent and cannot be used again.
6. The enrollment is audited.

The token is stored only as a digest, so it cannot be recovered from the
database or the audit log. See [Agent Enrollment](agent-security.md).

## Device Revocation

Each device can be revoked independently.

Trust is resolved from the database on every message rather than cached from
the TLS handshake, so a revoked credential fails immediately: the live
connection is closed, the next message on any surviving connection is refused,
and a reconnect is refused as well.

## Capability Model

A capability is a named, validated operation, never a command. The set is fixed
at build time on both sides, and this release defines ten of them:

```text
host.inventory
host.metrics
container.list
container.inspect
compose.list
compose.inspect
container.start
container.stop
container.restart
container.logs
```

Seven of those read; three change the state of a container, and each is gated
on its own permission and recorded in the audit trail. None of them removes
anything, and none carries a command, an argument list or input for a
container.

The server authorizes the user action and dispatches only a capability from
this catalog; a caller cannot pass a name of its own through to an agent.

The agent validates independently: the envelope, the expiry, the identifier
against a bounded replay cache, and the payload schema. It does not treat a
message as safe because an authenticated peer sent it.

The three lifecycle capabilities are the only ones that change a host. Each
takes a container identifier and nothing else, each holds its own permission,
and each is recorded as an action and in the audit trail. The container is read
again afterwards, so what is reported is what the host confirmed rather than
what was asked for.

`container.logs` carries a container's output outwards and nothing inwards. The
Docker API that would accept input — attach — is absent from the agent's client
interface, and the request type has no field a command or input could travel in,
so there is no request shape that turns a log stream into a console.

Log content is treated as sensitive everywhere. Dockplane cannot know what an
application prints, and applications print credentials and personal data, so a
line reaches the operator who holds `containers.logs` and is written nowhere
else: not to the database, not to the audit trail, not to the control server's
or the agent's own log.

Container removal, exec, attach and Compose operations are not implemented. The
code to perform them does not exist in the agent, so they are not reachable by
configuration or by a crafted request.

## Least Privilege

The agent runs as its own service account, holds its private key at owner-only
permissions, reaches Docker through the Engine API rather than a shell, and can
change only the run state of a container it was given the identifier of.

Docker daemon access is itself privileged: membership of the `docker` group is
effectively root on that host. That grant is unavoidable for Docker management
and is why the agent exposes no command execution. See
[Docker Integration](../integrations/docker.md).

## Replay Protection

Enrollment tokens are single-use and short-lived. A token is consumed by a
conditional update that also checks that it is unconsumed, unrevoked and
unexpired, so a replayed token is refused even under concurrent use.

Capability requests carry a unique identifier, an issued time and an expiry on
the authenticated channel. The agent refuses an expired request and refuses an
identifier it has already handled, from a cache bounded in both size and age.

## Browser Security

Use secure server-managed sessions.

Production:
- HTTPS
- HttpOnly
- Secure
- appropriate SameSite
- CSRF defense
- restrictive CORS

## Secrets

Secrets are redacted and encrypted when persisted.

Application encryption material must not be stored only inside the same database it protects.

## Audit

Important events include:
- login failure/success
- MFA changes
- password reset
- session revocation
- role changes
- agent enrollment
- agent revocation
- action request/result
- configuration changes

Audit logs must not become a secret store.
