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
at build time on both sides, and this release defines eighteen of them:

```text
read        host.inventory     host.metrics
            container.list     container.inspect    container.logs
            compose.list       compose.inspect

container   container.create   container.replace    container.remove
            container.start    container.stop       container.restart

stack       stack.deploy       stack.remove
            stack.start        stack.stop           stack.restart
```

Seven of those read. Eleven change something on a host, and each is gated on
its own permission and recorded in the audit trail. None of them carries a
command, an argument list or input for a container.

The server authorizes the user action and dispatches only a capability from
this catalog; a caller cannot pass a name of its own through to an agent.

The agent validates independently: the envelope, the expiry, the identifier
against a bounded replay cache, and the payload schema. It does not treat a
message as safe because an authenticated peer sent it.

Every capability that changes a host names the thing it acts on, holds its own
permission, and is recorded as an action and in the audit trail. What was
changed is read again afterwards, so what is reported is what the host
confirmed rather than what was asked for.

`container.start`, `container.stop` and `container.restart` take a container
identifier and nothing else. `container.create` and `container.replace` also
carry a typed container specification: it is a Dockplane type rather than a
Docker API payload, so an option Docker has and Dockplane has not modelled
cannot be requested, whatever a caller sends.

The stack capabilities act on a stack Dockplane deployed. `stack.deploy`
carries a typed plan the control server resolved from the stack's saved
configuration; the agent has no Compose parser, never receives a Compose file,
and there is no `docker compose` invocation behind it. `stack.start`,
`stack.stop` and `stack.restart` are three named operations rather than one
that takes the word to perform, and none of them creates, recreates or removes
anything.

`container.remove` and `stack.remove` are the two capabilities that take
something away. Both remove containers and nothing else: there is no field in
either in which a caller could ask for a volume.

Creating or replacing a container, and deploying a stack, need the images they
name. An image the host does not already have is pulled from the registry the
reference points at, which is the one case where an operation Dockplane started
causes outbound traffic from a managed host. An image already on the host is
not pulled again.

`container.logs` carries a container's output outwards and nothing inwards. The
Docker API that would accept input — attach — is absent from the agent's client
interface, and the request type has no field a command or input could travel in,
so there is no request shape that turns a log stream into a console.

Log content is treated as sensitive everywhere. Dockplane cannot know what an
application prints, and applications print credentials and personal data, so a
line reaches the operator who holds `containers.logs` and is written nowhere
else: not to the database, not to the audit trail, not to the control server's
or the agent's own log.

Exec, attach, a shell, and administration of the host operating system are not
implemented: nothing reboots a machine, installs a package or changes a system
setting. What Dockplane changes on a managed host it changes through the Docker
Engine — containers, and the stacks made of them. Volume and network operations
are not implemented either.

The code to perform any of this does not exist in the agent, so none of it is
reachable by configuration or by a crafted request.

A Compose project the agent discovered on a host is read-only. `compose.list`
and `compose.inspect` report it; no capability deploys, changes or removes it.
The stack capabilities act only on stacks Dockplane created and holds the
configuration for.

## Least Privilege

The agent runs as its own service account, holds its private key at owner-only
permissions, reaches Docker through the Engine API rather than a shell, and can
act only on the container or the stack a capability named.

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

A production deployment is served over HTTPS, and sessions are managed on the
server. The browser holds an opaque token in a cookie set `HttpOnly`,
`SameSite=Lax`, scoped to `/` and, outside development, `Secure`. The database
stores only the token's digest, so a copy of it contains nothing that can be
replayed as a cookie.

State-changing requests authenticated by that cookie pass two independent
checks: the request origin has to match the deployment's public address, and a
CSRF token bound to the session has to be presented. CORS is not treated as a
defence against this. A browser sends a cross-site form post whether or not the
response can be read, and the state change has already happened by then.

See [Authentication](authentication.md).

## Secrets

A stored secret is encrypted under `APPLICATION_ENCRYPTION_KEY`, and that key is
held outside the database it protects, so a copy of the database alone does not
open what is in it. A stack secret is never returned once it is set; a
second-factor secret is encrypted rather than hashed, because a code has to be
verified against it.

Secrets are redacted wherever they would otherwise be written: not into logs,
not into error telemetry, and not into the audit trail.

## Audit

Security-relevant and infrastructure-changing events carry the actor, the
action, the target, the result, a timestamp and the request correlation ID.
Sign-ins and their failures, second-factor changes, recovery-code use, role
assignment, session revocation, agent enrollment and revocation, host archiving,
and every container and stack action with its outcome are recorded.

Reads are not all recorded, and the trail is not a secret store. No password,
token, second-factor secret or recovery code reaches it, and neither does
anything a container printed: what is recorded about container output is that
somebody read it.

See [Authentication](authentication.md).
