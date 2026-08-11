# Agents

An agent is a Docker host's identity in Dockplane. This page covers running
agents; see [Agent Enrollment](agent-enrollment.md) for how one is created and
[Install the Dockplane Agent](../getting-started/agent-installation.md) for the
host side.

## What an agent does

An agent holds one outbound mutual-TLS connection to the gateway, says hello,
heartbeats, and answers capability requests. It initiates nothing else.

Discovery is driven by the server, not by the agent: the server decides how
often a host is read, so an agent cannot flood the control plane by reporting
as fast as it likes. A pass runs shortly after a connection is established and
about once a minute after that, with jitter, and passes for one agent never
overlap.

## Reading agents

```http
GET  /api/v1/agents
GET  /api/v1/agents/{id}
```

Both need `agents.read`. Each agent reports its status, whether it is currently
connected, when it was last seen and when its certificate expires.

Discovered infrastructure is read through its own endpoints:

```http
GET /api/v1/hosts                 hosts.read
GET /api/v1/hosts/{id}
GET /api/v1/containers            containers.read
GET /api/v1/containers/{id}
GET /api/v1/compose-projects      compose.read
GET /api/v1/compose-projects/{id}
```

Lists are paginated with `limit` (50 by default, 200 at most) and `offset`, and
report a total. Containers can be filtered by `hostId`, `state` and `project`,
and searched by name or image with `search`.

### Detail

`GET /api/v1/containers/{id}` and `GET /api/v1/compose-projects/{id}` return
more than the list does. The extra detail is read from the host when the request
arrives, through the `container.inspect` and `compose.inspect` capabilities,
rather than being collected on a schedule for records nobody is looking at.

The capability is chosen by the server from its catalog. A caller names a
record; there is no field, parameter or header that lets it name an operation.

A detail response carries `detail` (or `services`), `detailObservedAt` and
`stale`. The summary and the detail age separately, so a container listed a
moment ago can still carry detail that has not been refreshed.

Repeated requests do not turn into load on the managed host. A stored detail
counts as current for ten seconds, and requests arriving while one is in flight
share its answer instead of opening their own.

When the host cannot be reached — the agent is disconnected, or does not answer
before the capability timeout — the last known detail is returned with
`stale: true`. When nothing was ever read and the host is unreachable, the
request fails with `CONTAINER_DETAIL_UNAVAILABLE` or
`COMPOSE_DETAIL_UNAVAILABLE` rather than inventing a record.

If the host answers that a container no longer exists, that answer is newer than
anything stored: the record is removed and the request answers
`CONTAINER_NOT_FOUND`.

The only mutating endpoints are container start, stop and restart, each behind
its own permission and each recorded. Reading logs is read-only and behind a
permission of its own. Remove, exec and attach are not implemented anywhere in
this release. See [Container Operations](../operations/container-lifecycle.md)
and [Container Logs](../operations/container-logs.md).

## Freshness

Every record carries `observedAt` and `stale`.

A host whose agent is disconnected is stale immediately, however recent its
last observation was, because nothing is going to refresh it. An agent that is
connected but has not reported for three discovery intervals is stale too.

Nothing is deleted when an agent disconnects. The last known state is exactly
what an operator needs when a host goes quiet, so containers and Compose
projects stay visible and are marked stale rather than removed. Metrics are
returned with the moment they were taken and never presented as current
readings.

A record is removed only after a discovery pass that completed in full. A pass
that could not read everything updates what it saw and removes nothing, so a
single failed request cannot make a running container disappear.

## Operational events

Changes are recorded as operational events, separate from the audit trail:

```text
agent.connected
agent.disconnected
host.inventory.updated
container.discovered
container.state.changed
container.health.changed
container.removed
compose.discovered
compose.state.changed
compose.removed
inventory.sync.failed
```

Only changes are recorded. A poll that observes the same state as the last one
records nothing, so the event log stays readable.

Audit and operational events stay separate on purpose: mixing them would bury a
permission change under thousands of container state transitions.

## Revocation

```http
POST /api/v1/agents/{id}/revoke
```

Requires `agents.revoke`, which is deliberately separate from `agents.read` and
`agents.enroll`. The credential stops being trusted immediately, the live
connection is closed, and discovery for that agent stops.

A revoked agent that tries to reconnect is refused. The agent recognises the
refusal, stops retrying and exits with code 3; its systemd unit does not
restart on that code, because there is nothing to retry until the host is
enrolled again.

Revocation does not delete the host's inventory. It stops being refreshed and
is marked stale.

## Related

- [Agent Enrollment](agent-enrollment.md)
- [Agent Gateway](../architecture/agent-gateway.md)
- [Agent Protocol](../architecture/agent-protocol.md)
- [Docker Integration](../integrations/docker.md)
