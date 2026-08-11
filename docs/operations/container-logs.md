# Container Logs

Dockplane can read what a container has printed, and follow it as it prints
more. That is the whole of it: there is no console, no shell and no way to send
anything to a container.

## What log content is

**Dockplane cannot promise that a container's output is safe to read.**

An application decides what it prints. Applications print passwords, API keys,
session tokens, connection strings and personal data — sometimes deliberately at
debug level, often by accident in a stack trace. Nothing in Dockplane inspects
or redacts that, because nothing could do so reliably.

So `containers.logs` is a sensitive permission. Granting it grants whatever the
workloads on a host happen to write, now and in future. It is separate from
`containers.read` for exactly that reason: seeing that a container exists and
reading what it says are different decisions.

## Where log content goes, and where it does not

A line travels from the container to the Docker Engine, to the agent, to the
control server, to the browser of the operator who asked for it. It is written
nowhere along the way:

- not stored in PostgreSQL
- not written to the audit trail
- not written to the control server's log
- not written to the agent's log
- not sent to any analytics or telemetry

There is no log persistence and no log search index. When a viewer is closed,
what it held is gone.

## Reading logs

```text
GET /api/v1/containers/{id}/logs           snapshot of what was already printed
GET /api/v1/containers/{id}/logs/stream    the same history, then live
```

Both require `containers.logs`. The stream is server-sent events over the
ordinary session cookie: one direction, plain HTTP, nothing new to secure.

A caller names a container and chooses from a fixed set of options:

| Option | Meaning | Bound |
| --- | --- | --- |
| `tail` | historical lines | 0–5000, 200 by default |
| `since` | absolute lower bound | ISO 8601 with an offset |
| `timestamps` | include Docker's timestamps | on by default |
| `stdout`, `stderr` | which streams | at least one |

Nothing outside this list reaches Docker. The host, the agent and the Docker
identifier are derived by the server from the container the caller named, so a
browser cannot choose which machine is read.

## When a stream ends

A live stream is not a subscription that survives. It ends when:

- the browser disconnects — closing the tab or leaving the page is enough
- the agent disconnects or its credential is revoked
- the container disappears
- the session ends, the user is deactivated, or `containers.logs` is withdrawn
- the configured stream lifetime runs out
- output arrives faster than the browser can take it
- the control server shuts down

The session, the permission and the agent are re-checked on an interval while a
stream runs, because none of those changes is something a browser would report.
Ending is always visible: the viewer says it is disconnected and why, and offers
to reconnect. A new connection is authorized again from scratch.

## Limits

Every stream holds a Docker reader open on a managed host and a connection open
on the control server, so the number of them is bounded by policy:

| Setting | Default | What it bounds |
| --- | --- | --- |
| `LOG_STREAM_MAX_PER_USER` | 3 | streams one operator may hold |
| `LOG_STREAM_MAX_PER_AGENT` | 10 | streams against one host |
| `LOG_STREAM_MAX_TOTAL` | 50 | streams on the control server |
| `LOG_STREAM_MAX_LIFETIME` | 30m | how long one stream may run |
| `LOG_STREAM_REVALIDATE_INTERVAL` | 30s | how often authority is re-checked |
| `LOG_STREAM_MAX_BUFFERED_BYTES` | 1 MiB | unwritten bytes before a stream is cut |
| `LOG_STREAM_KEEPALIVE_INTERVAL` | 20s | how often a quiet stream is kept open |

Exceeding a count answers `LOG_STREAM_LIMIT_REACHED`.

Several operators may watch the same container at once. Streams are independent;
there is no single reader they queue behind.

## Quiet streams

A container may print nothing for minutes. To whatever sits between the browser
and the control server, that looks like an idle connection worth closing, so the
stream writes an event-stream comment on an interval:

```text
: keepalive
```

It carries nothing and is not an event: a client that follows the format sees no
data and shows no line. It holds the connection open and does nothing else — the
session, the permission and the agent are re-checked on their own schedule, and
a stream that has lost any of them ends there however healthy the socket looks.

The comment stops with the stream.

## When output is lost

Log output can arrive faster than it can be delivered. Rather than growing
memory anywhere, Dockplane drops lines and says so — at the agent, at the
control server, and in the browser, each with its own bound. The viewer reports
how many lines were lost and marks the log as incomplete.

Nothing is dropped silently. A log with an invisible gap is worse than one that
admits it has a gap.

## Errors

| Code | Meaning |
| --- | --- |
| `PERMISSION_DENIED` | The operator does not hold `containers.logs`. |
| `CONTAINER_NOT_FOUND` | No such container is registered. |
| `AGENT_OFFLINE` | No agent is connected for that host. |
| `AGENT_REVOKED` | The host has no credential that may be used. |
| `CAPABILITY_UNSUPPORTED` | The agent does not implement log reading. |
| `LOG_STREAM_UNAVAILABLE` | The host could not read the logs. |
| `LOG_STREAM_TIMEOUT` | The stream reached its maximum lifetime. |
| `LOG_STREAM_OVERFLOW` | Output outran the browser and the stream was cut. |
| `LOG_STREAM_LIMIT_REACHED` | Too many streams are already open. |

## Audit

Opening and closing a stream are recorded as `container.logs.opened` and
`container.logs.closed`, with the actor, the container, the host, the stream
identifier and how it ended. One pair per stream: a client reconnecting in a
tight loop writes two entries per attempt, which the stream limits bound but do
not aggregate.

The content is not. The audit trail is read by people who may not hold
`containers.logs`, and it is kept far longer than any log viewer.

## Related

- [Docker Integration](../integrations/docker.md)
- [Roles and Permissions](../administration/roles.md)
- [Container Operations](container-lifecycle.md)
