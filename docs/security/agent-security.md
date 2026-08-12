# Agent Enrollment

Enrollment is how a Docker host obtains its own identity. An administrator
issues a short-lived token, the host exchanges it once for a client
certificate, and the token is spent in the process.

Enrollment tokens are not agent credentials. A token cannot connect to the
gateway, and a certificate cannot be enrolled with again.

## Prerequisites

The agent CA must exist before the control server starts. See
[Agent Identity](../reference/agent-identity.md).

Enrollment requires the `agents.enroll` permission. Revocation requires
`agents.revoke`, which is deliberately separate: reading and enrolling do not
imply the ability to cut a host off.

## Issue a Token

```http
POST /api/v1/agents/enrollment-tokens
```

```json
{
  "intendedHostname": "docker-01"
}
```

`intendedHostname` is an operator label to help you recognise the token later.
It is never treated as an identity.

The response contains the token once:

```json
{
  "id": "0f2c…",
  "token": "…",
  "expiresAt": "2026-08-09T12:10:00.000Z",
  "note": "This token is shown once and cannot be retrieved again."
}
```

Only a SHA-256 digest is stored. The raw value cannot be shown again, recovered
from the database or read out of the audit log, so treat the response as the
one delivery. `GET /api/v1/agents/enrollment-tokens` lists tokens and their
state without ever returning a raw value.

Tokens carry at least 256 bits of entropy and expire after
`AGENT_ENROLLMENT_TTL`, 10 minutes by default. Issue one when the host is ready
to enroll, not in advance.

An unused token can be withdrawn:

```http
POST /api/v1/agents/enrollment-tokens/{id}/revoke
```

## Enroll a Host

The agent generates a key pair, keeps the private key on the host and sends a
certificate request:

```http
POST /api/v1/agent-enrollments
```

```json
{
  "token": "…",
  "csr": "-----BEGIN CERTIFICATE REQUEST-----…",
  "protocolVersion": 1,
  "hostname": "docker-01"
}
```

This is the only unauthenticated write in the API. It carries no session,
because the host has no identity yet; the token is the entire authorisation.
The endpoint is rate limited.

On success the response carries everything the agent needs and nothing it does
not:

```json
{
  "agentId": "…",
  "certificate": "-----BEGIN CERTIFICATE-----…",
  "caChain": "-----BEGIN CERTIFICATE-----…",
  "gatewayUrl": "https://dockplane.example.com:9443",
  "protocolVersion": 1,
  "certificateNotAfter": "2026-09-08T12:00:00.000Z"
}
```

The private key never leaves the host and Dockplane never sees it.

### Single Use

A token is claimed by a conditional update that consumes it and checks that it
is unconsumed, unrevoked and unexpired in the same statement. Concurrent
attempts with the same token therefore produce exactly one agent: one request
receives a certificate and the rest are refused.

The certificate request is validated before the token is spent, so a host that
sends a malformed request can correct it and retry rather than burning its one
attempt.

### Refusals

| Code | Cause |
| --- | --- |
| `ENROLLMENT_TOKEN_INVALID` | The token does not exist. |
| `ENROLLMENT_TOKEN_CONSUMED` | The token was already used. |
| `ENROLLMENT_TOKEN_EXPIRED` | The token is past its expiry. |
| `ENROLLMENT_TOKEN_REVOKED` | An administrator withdrew the token. |
| `ENROLLMENT_CSR_INVALID` | The certificate request was refused. |

`ENROLLMENT_CSR_INVALID` states the rule that was broken without echoing
parser internals.

## Verify

`GET /api/v1/agents` lists enrolled agents with their status, certificate
expiry and whether they are currently connected. An agent appears as connected
once it has completed `hello` on the gateway.

## Revoke

```http
POST /api/v1/agents/{id}/revoke
```

```json
{
  "reason": "host decommissioned"
}
```

The credential stops being trusted immediately, the live connection is closed,
and the reason and actor are recorded. Revocation is not reversible; a host
that should return is enrolled again and receives a new identity.

## Audit

Enrollment writes:

- `agent.enrollment_token.created`
- `agent.enrollment_token.revoked`
- `agent.enrollment_token.consumed`
- `agent.enrolled`
- `agent.certificate.renewed`
- `agent.revoked`

No entry contains a token, a certificate request or key material.

## Related

- [Agent Identity](../reference/agent-identity.md)
- [Agent Gateway](../reference/agent-gateway.md)
- [Roles and Permissions](authentication.md)
