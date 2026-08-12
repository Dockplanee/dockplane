# Container Operations

Dockplane can start, stop and restart a container it has discovered. These are
the only operations that change a managed host.

Remove, exec, a shell, log streaming, Compose deploy or down, image pull and
volume or network changes are not implemented. They are not hidden behind a
permission or a flag; no code exists to perform them.

## What a request contains

An operator names a container and an operation. Nothing else travels:

```text
POST /api/v1/containers/:id/start      requires containers.start
POST /api/v1/containers/:id/stop       requires containers.stop
POST /api/v1/containers/:id/restart    requires containers.restart
```

There is one route per operation rather than one route taking an operation
name. A single endpoint would make the set of things Dockplane can do to a host
a property of the request body rather than of the code, and every future
capability would arrive already reachable.

The host, the agent and the Docker identifier are derived by the server from
the container. A browser never chooses which machine an operation lands on.

## Permissions

Each operation has its own permission — `containers.start`, `containers.stop`,
`containers.restart` — so restart can be granted without granting stop. See
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
| `ACTION_CONFLICT` | Another operation is already running on that container. |
| `CONTAINER_ALREADY_RUNNING` | Start, on a container that is already running. |
| `CONTAINER_ALREADY_STOPPED` | Stop, on a container that is not running. |
| `DOCKER_PERMISSION_DENIED` | The Docker daemon refused the agent. |
| `DOCKER_UNAVAILABLE` | The Docker daemon could not be reached. |
| `DOCKER_OPERATION_FAILED` | Anything else Docker reported. |

Nothing is queued. An operation runs against a connected agent or it is
refused: a stop requested while a host was unreachable must not arrive hours
later and take down a service nobody is watching.

Operations are serialised per container, not globally, so one slow restart does
not block a fleet. A second operation on the same container is refused rather
than queued — with two in flight, neither the operator nor the audit trail
could say which one produced the state that resulted.

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
