# Docker Integration

## Scope

Dockplane reads a Docker host through an agent installed on it. The agent talks
to the local Docker Engine over the Engine API using the official Go SDK.

Discovery is read-only. What Dockplane changes on a host is the run state of a
container it discovered, the containers it created itself, and the stacks it
deployed. It also reads container output. Everything else the Docker API
exposes is absent from the agent.

## Capabilities

The capability set is fixed at build time and is exactly:

| Capability | Returns |
| --- | --- |
| `host.inventory` | hostname, OS and version, architecture, kernel, uptime, CPU count and model, total memory, Docker Engine version, agent version |
| `host.metrics` | CPU utilisation, memory used and total, root filesystem used and total, load average, and the moment observed |
| `container.list` | every container, running or not, normalised |
| `container.inspect` | one container, projected field by field |
| `compose.list` | Compose projects grouped from their labels |
| `compose.inspect` | one Compose project with its services |
| `container.start` | starts one container, and reports the state observed afterwards |
| `container.stop` | stops one container, and reports the state observed afterwards |
| `container.restart` | restarts one container, and reports the state observed afterwards |
| `container.create` | creates one container from a typed specification |
| `container.replace` | replaces one container with a new specification, keeping its identity |
| `container.remove` | removes one container, and no volume |
| `stack.deploy` | applies a resolved plan for one stack |
| `stack.start` | starts the containers of a deployed stack |
| `stack.stop` | stops the containers of a deployed stack |
| `stack.restart` | restarts the containers of a deployed stack |
| `stack.remove` | removes the containers of a stack, and no volume |
| `container.logs` | streams one container's output, historical and live |

Both sides check the list. A capability the server will not dispatch is also
one the agent refuses to run.

## Container lifecycle

A run-state capability — start, stop or restart — takes a container identifier
and nothing else. There is no field in which a caller could name an operation,
a command or a flag, and an identifier that does not look like one is refused
before the Engine API is touched.

Each maps to exactly one Engine API call. Restart in particular is a single
`ContainerRestart`, never a stop followed by a start: sequencing them would open
a window in which the container is down with nothing recorded as running, and a
failure between them would leave the trail describing a restart that actually
stopped something.

The agent decides the stop timeout — 30 seconds — rather than accepting one from
the request. A caller that could choose it could also choose zero and turn a
graceful stop into a kill.

An operation that does not apply is refused rather than reported as done:

| Situation | Result |
| --- | --- |
| starting a container that is already running | `CONTAINER_ALREADY_RUNNING` |
| stopping a container that is not running | `CONTAINER_ALREADY_STOPPED` |
| the daemon refuses the operation | `DOCKER_PERMISSION_DENIED` |
| the daemon cannot be reached | `DOCKER_UNAVAILABLE` |
| anything else Docker reported | `DOCKER_OPERATION_FAILED` |

Restarting a stopped container is not refused. Docker starts it, and the agent
does not second-guess that: the operator asked for the container to be running.

The answer carries the state Docker reported after the call returned, not the
state that was asked for.

## Container logs

`container.logs` reads through the Engine Logs API. Docker's attach endpoint —
the one that carries stdin — is absent from the agent's client interface, so no
request shape can reach it. The stream is one-directional by construction: the
agent opens a reader, copies what comes out of it and closes it. There is no
handle a caller could write to.

A request names a container and a fixed set of options: `tail`, `since`,
`timestamps`, `stdout`, `stderr` and `follow`. Nothing else is forwarded, and a
payload carrying a field the agent does not model — a command, an argument list,
input — is refused rather than ignored.

Without a TTY the daemon multiplexes both streams onto one connection with an
8-byte frame header per frame. The agent demultiplexes with the SDK's own
reader, so a header never reaches a viewer as text and stdout stays
distinguishable from stderr. A TTY container has one stream and no headers, and
is read as it comes.

Timestamps are separated from the message only when they parse. Nothing is
invented for a line that carries none.

### Bounds

Nothing is buffered without limit, in either direction:

| Bound | Value |
| --- | --- |
| longest line forwarded intact | 8 KiB, then cut and marked |
| lines per batch | 200 |
| bytes per batch | 64 KiB |
| batch interval | 100 ms |
| batches queued for the connection | 32 |
| historical lines a request may ask for | 5000 |
| agent-side stream ceiling | 60 minutes |

A consumer that cannot keep up loses lines. They are counted and the count
travels with the next batch, so the viewer says the log is incomplete rather
than presenting a gap as the whole story. The agent never blocks on a slow
consumer: waiting would stop it reading from Docker, which moves the backlog
into the daemon instead of solving it.

## Not implemented

Exec, attach, a shell, and volume or network changes are not implemented. They
are not hidden behind a permission or a feature flag; the code to perform them
does not exist in the agent.

There is no `docker compose` invocation and no Compose parser in the agent: a
stack is deployed from a plan the control server resolved. A Compose project
the agent discovered on a host is reported and never changed.

There is no image management, and no operation whose purpose is to pull an
image. An image is pulled only as a step of creating or replacing a container
or deploying a stack, and only when the host does not already have it.

## What is transmitted

Container discovery reports a deliberate projection, not a filtered copy of the
Docker payload:

- identifiers, name, image and image id
- state, status and health
- restart count and restart policy
- created, started and finished times, and exit code when stopped
- published and exposed ports, including the host address bound to
- network names
- named volumes, and for a bind mount only that it exists and whether it is
  writable
- configured memory, CPU and PID limits
- the canonical Compose labels

## What is never transmitted

The full inspect payload is not forwarded, because it routinely carries
secrets. Specifically excluded:

- environment variables, names and values alike
- registry credentials and authentication configuration
- the configured command and entrypoint
- host paths behind bind mounts
- container filesystem detail
- any label other than the Compose ones the product groups by

Labels are an allow list rather than a deny list. Labels are free-form and are
commonly used for deployment metadata, so only `com.docker.compose.project`,
`.service`, `.container-number` and `.oneoff` are forwarded.

## Compose discovery

Projects are grouped from the labels Compose writes, not from container names.
A name is a convention an operator can break and an attacker can imitate; the
label is what Compose itself uses to find its own containers.

The Compose working directory and config file paths are recorded by Compose but
are not reported: they describe the host's filesystem layout, and a read-only
view has no use for them.

## Docker socket

Docker daemon access is privileged. Membership of the `docker` group, or access
to `/var/run/docker.sock`, is effectively root on that host: anything able to
reach the daemon can start a privileged container that mounts the host
filesystem.

This is unavoidable for Docker management, and it is why the agent exposes no
generic command execution. See
[Install the Dockplane Agent](../operations/agent.md).

Do not expose the daemon over unauthenticated TCP. Do not mount a remote Docker
socket into the control server.

## Availability

A Docker daemon that is down, or one the agent may not use, is an operational
state rather than a failure. The agent reports a structured `DOCKER_UNAVAILABLE`
and keeps running, host inventory and metrics still answer, and the control
server keeps the last observation and marks it stale.

## When each capability runs

`host.inventory`, `host.metrics`, `container.list` and `compose.list` run on the
server's discovery schedule, about once a minute per connected agent.

`container.inspect` and `compose.inspect` run only when someone opens the
corresponding detail view. Inspecting every container on every host on a
schedule would put continuous load on a fleet to collect data that is mostly
never read.

The lifecycle capabilities run only when an operator asks for one, and only
against a connected agent. There is no queue: an operation is carried out now or
refused. A stop that was requested while a host was unreachable must not arrive
hours later and take down a service nobody is watching.

Each operation is followed by a `container.inspect` against the same host, so
the answer describes what the container is rather than what was asked of it.

The detail the server stores is rebuilt field by field from what the agent
reported. The agent already refuses to send environment values, credentials, the
configured command and host paths; the server rebuilds the record anyway, so an
agent that reported more than it should — because it was modified, or
compromised — still cannot put that data into the control server's database.

## Freshness

Every discovered record carries `observedAt` and a `stale` flag. A host whose
agent is disconnected is stale immediately, however recent its last observation
was, because nothing is going to refresh it. Nothing is deleted on disconnect:
the last known state is what an operator needs when a host goes quiet.

Records are removed only after a discovery pass that completed in full. A pass
that could not read everything updates what it saw and removes nothing.
