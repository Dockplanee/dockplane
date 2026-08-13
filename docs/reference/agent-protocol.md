# Agent Protocol

The protocol between the control server and an agent. It is not a remote shell
protocol and has no message that carries a command.

Messages are newline-delimited JSON over the mutual-TLS connection described in
[Agent Gateway](agent-gateway.md). Every message carries `protocolVersion`. A
version the server does not implement is refused rather than guessed at.

Protocol version 1 carries identity, liveness and capability requests. A
capability request names a capability from a fixed catalog and its input; it
never carries a command.

## Handshake

The agent opens the connection and sends `hello`:

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "agentVersion": "0.1.0"
}
```

The server answers:

```json
{
  "type": "hello_ack",
  "protocolVersion": 1,
  "agentId": "…",
  "heartbeatIntervalSeconds": 30,
  "certificateNotAfter": "2026-09-08T12:00:00.000Z",
  "renewAfter": "2026-09-01T12:00:00.000Z"
}
```

`renewAfter` is when the agent should start renewing, derived from
`AGENT_CERT_RENEW_BEFORE`. The renewal window is a deployment policy, so the
server states it instead of leaving every agent to decide when its certificate
is old enough.

`agentId` comes from the registry lookup on the peer certificate. It tells the
agent which identity the server recognises it as; it is not something the agent
supplies. There is no field in any client message that names an agent.

`hello` must come first. Any other message on a fresh connection is refused
with `AGENT_PROTOCOL_UNSUPPORTED`.

## Heartbeat

```json
{ "type": "heartbeat", "protocolVersion": 1 }
```

```json
{ "type": "heartbeat_ack", "protocolVersion": 1 }
```

The agent heartbeats at the interval it was given. A connection silent for
three intervals is closed. The heartbeat updates last-seen state for the
certificate holder, never for an identity named in the payload.

## Certificate Renewal

```json
{
  "type": "certificate.renew",
  "protocolVersion": 1,
  "csr": "-----BEGIN CERTIFICATE REQUEST-----…"
}
```

```json
{
  "type": "certificate.renewed",
  "protocolVersion": 1,
  "certificate": "-----BEGIN CERTIFICATE-----…",
  "certificateNotAfter": "2026-10-08T12:00:00.000Z",
  "renewAfter": "2026-10-01T12:00:00.000Z"
}
```

Renewal takes no token. The current certificate authenticated the connection,
and that is the proof of identity. The agent ID is carried over unchanged, so
renewing cannot turn one agent into another.

The server recognises only the replacement from that moment on, so the
connection that carried the request — authenticated with the superseded
certificate — can no longer be attributed to an agent. Reconnecting with the new
material is part of the rotation, not a failure.

## Capability Requests

The server asks; the agent answers. This is the only direction: an agent never
initiates a capability, and it cannot report state the server did not ask for.

```json
{
  "type": "request",
  "protocolVersion": 1,
  "id": "f38e14df-6659-49fe-87c1-bcd49df9f326",
  "capability": "container.list",
  "issuedAt": "2026-08-09T12:00:00.000Z",
  "expiresAt": "2026-08-09T12:00:20.000Z",
  "payload": {}
}
```

```json
{
  "type": "response",
  "protocolVersion": 1,
  "id": "f38e14df-6659-49fe-87c1-bcd49df9f326",
  "capability": "container.list",
  "status": "success",
  "payload": { "containers": [], "observedAt": "2026-08-09T12:00:01.000Z" }
}
```

The capability is echoed in the reply. A reply whose identifier matches but
whose capability does not is refused: it answers a different question than the
one that was asked.

`expiresAt` is enforced by both sides. A request that waited in a queue, or was
replayed, must not run late against a host whose state has moved on.

Several requests may be outstanding at once. They are correlated by identifier,
so replies may arrive in any order.

### What the server refuses

- a reply with no matching outstanding request
- a second reply to a request already answered
- a reply for a different capability than was requested
- a reply arriving on a connection other than the one that made the request
- any reply before `hello`

Each of these closes the connection. The last one matters most: without it, a
late reply on a replaced connection could satisfy a request belonging to the
new one, and one host's answer would be read as another's.

### What the agent refuses

- a request whose envelope is malformed or whose window is incoherent
- an expired request
- an identifier it has already handled, held in a bounded, time-limited cache
- a capability it does not implement

Several capabilities change a host, so a replayed request is a duplicated
action: a restart delivered twice is a service interrupted twice. The guard
applies to every request rather than to the mutating ones, so a capability that
becomes mutating later is already covered.

## Capabilities

Version 1 defines exactly fourteen. Six read, three change the run state of one
container, three build or remove one, one deploys a stack, and one streams a
container's output:

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
container.create
container.replace
container.remove
stack.deploy
stack.start
stack.stop
stack.restart
container.logs
```

`container.logs` answers over time rather than once. Nothing else does.

A capability that changes the run state of a container takes a container
identifier and nothing else, and the control server derives that identifier from
the container the operator named — a caller never chooses which host or which
Docker object an operation reaches.

The four that build things carry a typed specification instead: named fields for
an image, an environment, ports, mounts, networks and a restart policy. What may
be asked for is the shape of that type, so a Docker option Dockplane has not
modelled cannot be requested at all — there is no field for `privileged`, for a
raw bind list or for a host namespace.

`stack.deploy` carries several of those specifications, plus the networks and
volumes they need and the order the services start in. It does not carry a
Compose file: Compose is read by the control server, and the agent has no parser
for one.

`stack.start`, `stack.stop` and `stack.restart` carry less: the stack, the
revision the control server believes is deployed, the services it expects and
which of them waits for which. No image, no specification and nothing that could
create a container — these move containers that already exist. Three named
operations rather than one that takes the word to perform, for the same reason
the container operations are three.

The plan it carries has a version of its own, separate from the protocol's. A
plan describes a revision to *apply* — the agent may find the stack already
running and has to move it — and an agent that speaks an older plan version
refuses one it does not recognise rather than reading a newer server's
intention into an older operation.

Both sides hold the list. A capability the server will not dispatch is also one
the agent refuses to run, and a REST caller cannot pass a capability name
through to an agent — it names one from the catalog or nothing at all.

## Streams

A streaming capability is dispatched like any other, with one addition: the
request carries a `streamId` the server generated. What follows is bound to it.

```text
server -> agent   request        id, capability, streamId, payload
agent  -> server  stream_started id, capability, streamId
agent  -> server  stream_chunk   id, streamId, seq, payload, dropped
agent  -> server  stream_end     id, streamId, reason, error?
server -> agent   stream_cancel  id, streamId
```

The identifier is the server's and is only echoed by the agent, so a chunk can
always be placed. Three things have to agree before one is accepted: the request
identifier, the stream identifier, and the connection it arrived on. A chunk
produced on a connection that has since been replaced is refused rather than
delivered into a stream belonging to the new one.

Chunks are numbered from zero. A gap or a repeat ends the stream instead of
being papered over: the agent does not keep what it has already sent, so a hole
could not be repaired, and showing an operator a log with an invisible gap is
worse than telling them it broke.

`reason` is one of `completed`, `cancelled`, `failed` or `expired`. A stream
ends when the agent finishes, when either side cancels, when the connection
closes, or when a ceiling is reached — the agent's own, or the server's
configured stream lifetime.

`dropped` counts what the agent discarded because the consumer could not keep
up. It travels with the data rather than being logged, so the loss reaches the
person reading the log.

## Errors

```json
{
  "type": "error",
  "protocolVersion": 1,
  "code": "AGENT_REVOKED",
  "message": "The agent credential has been revoked."
}
```

| Code | Meaning |
| --- | --- |
| `AGENT_CERT_INVALID` | No usable client certificate on the connection. |
| `AGENT_UNKNOWN` | The certificate is not associated with an agent. |
| `AGENT_REVOKED` | The credential has been revoked. |
| `AGENT_CERT_EXPIRED` | The certificate is past its validity window. |
| `AGENT_IDENTITY_MISMATCH` | The identity of the connection changed. |
| `AGENT_PROTOCOL_UNSUPPORTED` | Unknown message, or one sent out of order. |
| `AGENT_MESSAGE_TOO_LARGE` | The message exceeds the permitted size. |
| `ENROLLMENT_CSR_INVALID` | The certificate request was refused. |
| `AGENT_RESPONSE_INVALID` | A reply did not match an outstanding request. |

Most errors close the connection. A refused certificate request does not: the
agent stays connected and can correct the request.

## Parsing

A message is accepted only if it is an object with a known `type` and a numeric
`protocolVersion`, and it carries the fields that type requires. Nothing is
inferred from a partially understood payload.

## Compatibility

A breaking change requires a new protocol version. The server accepts a range
between a declared minimum and the current version, so agents and control
server can be upgraded separately within that window.

## Related

- [Agent Identity](agent-identity.md)
- [Agent Gateway](agent-gateway.md)
