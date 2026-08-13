# Container Operations

Dockplane can start, stop and restart a container it has discovered, and can
create, change and remove a container it manages itself. These are the only
operations that change a managed host.

Exec, a shell, image pull and volume or network changes are not implemented.
They are not hidden behind a permission or a flag; no code exists to perform
them.

## What a request contains

An operator names a container and an operation. Nothing else travels:

```text
POST   /api/v1/containers/:id/start    requires containers.start
POST   /api/v1/containers/:id/stop     requires containers.stop
POST   /api/v1/containers/:id/restart  requires containers.restart
POST   /api/v1/containers              requires containers.create
PUT    /api/v1/containers/:id          requires containers.update
DELETE /api/v1/containers/:id          requires containers.delete
```

A container is described in Dockplane's own fields — image, ports, mounts,
environment, networks, restart policy, labels, healthcheck — and never as a
Docker API payload. A field that is not in that list cannot be asked for, which
is what keeps privileged mode, host namespaces, devices and arbitrary
capabilities off the remote surface entirely. The host is named as a Dockplane
resource; the agent and the Docker identifier are not named at all.

There is one route per operation rather than one route taking an operation
name. A single endpoint would make the set of things Dockplane can do to a host
a property of the request body rather than of the code, and every future
capability would arrive already reachable.

The host, the agent and the Docker identifier are derived by the server from
the container. A browser never chooses which machine an operation lands on.

## Changing a container

Docker cannot change a running container's ports, mounts or environment, so
changing one means replacing it. Dockplane does that as one operation: it holds
what the container is supposed to be, applies what the operator changed, and
sends the whole configuration — so two edits cannot interleave into something
nobody asked for, and nothing is merged on a host.

The container keeps its identity. Docker gives the replacement a new identifier;
the Dockplane container, its history and its address stay the same.

Volumes are never removed, with a replacement or with a removal, named or
anonymous. There is no field to set and no default to get wrong.

Secrets are stored encrypted under a key the database does not contain, and are
never sent back to a browser. A form that has not been shown a value says the
value is unchanged, and the server carries the stored one across.

## Permissions

Each operation has its own permission — `containers.start`, `containers.stop`,
`containers.restart`, `containers.create`, `containers.update`,
`containers.delete` — so restart can be granted without granting stop, and
changing a container's configuration does not imply being able to delete it. See
[Roles and Permissions](../security/authentication.md).

The interface offers a control only where it could succeed, but that is a
convenience. The control server authorizes every request independently, and the
permission is checked before an action is recorded, before an agent is chosen
and before anything is sent. A request an operator may not make leaves no trace
on the machine it was aimed at.

## When an operation is refused

| Code | Meaning |
| --- | --- |
| `CONTAINER_NOT_FOUND` | No such container is registered. |
| `AGENT_REVOKED` | The host has no agent credential that may be used. |
| `AGENT_OFFLINE` | No agent is connected for that host. |
| `ACTION_CONFLICT` | Another operation is already running on that container, or an earlier one never resolved. |
| `CONTAINER_ALREADY_RUNNING` | Start, on a container that is already running. |
| `CONTAINER_ALREADY_STOPPED` | Stop, on a container that is not running. |
| `DOCKER_PERMISSION_DENIED` | The Docker daemon refused the agent. |
| `DOCKER_UNAVAILABLE` | The Docker daemon could not be reached. |
| `CONTAINER_NAME_IN_USE` | Another container on that host already has the name. |
| `CONTAINER_NOT_MANAGED` | Dockplane did not create it, so it will not change or remove it. |
| `MANAGED_BY_STACK` | It belongs to a Compose project, and its configuration comes from there. |
| `VALIDATION_FAILED` | The specification is not one Dockplane accepts. |
| `OPERATION_OUTCOME_UNKNOWN` | The request reached the host and its result did not come back. |
| `DOCKER_OPERATION_FAILED` | Anything else Docker reported. |

Nothing is queued. An operation runs against a connected agent or it is
refused: a stop requested while a host was unreachable must not arrive hours
later and take down a service nobody is watching.

Operations are serialised per container, not globally, so one slow restart does
not block a fleet. A second operation on the same container is refused rather
than queued — with two in flight, neither the operator nor the audit trail
could say which one produced the state that resulted.

## When the result does not come back

A request can reach a host and its answer can be lost — to a timeout, or to a
connection that dies while Docker is working. Dockplane does not report that as
a failure, because it is not one: the container may have been created, replaced
or removed exactly as asked.

It answers `OPERATION_OUTCOME_UNKNOWN`, records the attempt in the audit trail
as interrupted rather than failed, and leaves the operation open. The container
accepts no further changes until the next complete reading of its host settles
what happened. Nothing is repeated: a retried request is refused rather than
starting a second change on top of a first that may already have taken.

## A container whose last change never finished

Changing a container's configuration is a Docker side effect, and a control
server that stops partway through one leaves a container that is either the
configuration it was or the configuration it was becoming. Until that is
settled, operations on it are refused with `ACTION_CONFLICT` — a restart of a
container nobody can describe would produce a result nobody can describe either.

Settling it does not need an operator. The container carries the identity of the
configuration it is running, so the next complete discovery pass establishes
which one happened, and the server records the outcome against the action the
operator originally started. The audit trail says so explicitly:
`container.recovery.promoted` when the change took, `container.recovery.discarded`
when it did not.

Two cases are not settled automatically, and both say so rather than guessing:

| Code | Meaning |
| --- | --- |
| `CONTAINER_IDENTITY_CONFLICT` | Two containers claim to be this one. Choosing between them would mean guessing, and a wrong guess removes a running workload. |
| `CONTAINER_STATE_UNRESOLVED` | The container claims a configuration the server does not have, or will not say which one it is running. |

Both leave the container readable and refuse every operation on it until a
person resolves which container is the real one. Nothing is removed in the
meantime.

## What the answer means

```json
{
  "actionId": "…",
  "status": "succeeded",
  "state": "running",
  "health": "healthy",
  "observedAt": "2026-08-09T12:00:03.120Z"
}
```

`state` is what the host reported when the container was read again after the
operation, not what was asked for. A start that returned is not a container
that is running, and the interface never paints the new state on the strength
of the request.

The re-read asks the host again rather than using the stored projection, even
when that projection is seconds old: a container inspected just before the
operation would otherwise be reported as the state the operation produced.

### Timeouts

`status: "timed_out"` means the control server stopped waiting. It does not
mean Docker did nothing. The container is read again anyway and the answer
carries what was observed, because an operator needs to know what is true
rather than what was requested.

## What is recorded

Every operation produces an action record with the actor, the capability, the
target, the host, its status, when it was requested and completed, and the
error code if there was one. The history is available to anyone holding
`containers.read`:

```text
GET /api/v1/actions
```

The audit trail separately records the request and its outcome —
`container.start.requested` and then `container.start.succeeded` or
`.failed` — with the actor, the target and the action identifier. A successful
operation also records an operational event against the host.

Audit answers who changed what about the system. The action history answers
what happened on a host, and how long it took. Neither carries a payload or a
secret.

## On the host

The agent maps each operation to exactly one Docker Engine API call. Restart is
a single `ContainerRestart`, never a stop followed by a start. The stop timeout
is the agent's — 30 seconds — and is not something a request can choose.

See [Docker Integration](../integrations/docker.md).
