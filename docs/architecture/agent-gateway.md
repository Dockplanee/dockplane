# Agent Gateway

The agent gateway is a separate TLS listener from the browser API. Agents
connect to it and are required to present a client certificate; browsers
connect to the API and are not.

Two listeners rather than one, because the requirements are opposite. Demanding
a client certificate from browsers would make the product unusable, and making
it optional on a shared listener would mean an unauthenticated peer reaches the
agent surface.

| Listener | Default port | Authentication |
| --- | --- | --- |
| Control API | 3000 | Session cookie plus CSRF token |
| Agent gateway | 9443 | Mutual TLS |

Both start in the same process. Configure the gateway with
`AGENT_GATEWAY_HOST`, `AGENT_GATEWAY_PORT` and `AGENT_GATEWAY_ADVERTISED_URL`;
the advertised URL is what enrolling agents are told to connect to, and it must
use `https` in production.

## Mutual TLS

The listener sets both `requestCert` and `rejectUnauthorized`. The first alone
would ask for a certificate and carry on without one; the second is what makes
an absent or untrusted certificate fail the handshake. The minimum version is
TLS 1.2.

Trust is anchored at `AGENT_CLIENT_CA_CERT_PATH`, the internal agent CA. A
certificate from any other authority does not complete the handshake.

Failed handshakes are logged at debug level. A public listener attracts
scanners and probing, and an attacker should not be able to fill the log by
connecting repeatedly.

## Identity Resolution

After the handshake, the gateway hashes the DER encoding of the verified peer
certificate and looks the fingerprint up in the agent registry. That lookup is
the identity. It runs on every message, not once per connection, so a
revocation that lands mid-connection stops the very next message.

Resolution refuses, in order:

| Condition | Error code |
| --- | --- |
| No peer certificate | `AGENT_CERT_INVALID` |
| Fingerprint not in the registry | `AGENT_UNKNOWN` |
| Agent revoked | `AGENT_REVOKED` |
| Certificate expired | `AGENT_CERT_EXPIRED` |

## Connection Handling

- A connection that does not complete its handshake within 10 seconds is
  dropped.
- After `hello`, the idle timeout is three missed heartbeats.
- A peer that never sends a newline cannot grow the receive buffer past
  `AGENT_MAX_MESSAGE_BYTES` (1 MiB by default); the connection is told
  `AGENT_MESSAGE_TOO_LARGE` and closed.
- Only one connection per agent is live at a time. A second connection from the
  same identity replaces the first, so an agent that reconnects after a network
  partition is not locked out by its own stale socket.

Connection state is held in memory and is not authoritative. On startup the
registry clears connection state left behind by a previous process, so a
restart cannot leave agents reported as connected.

## Reverse Proxies

If a reverse proxy sits in front of the gateway, it must pass TCP through
without terminating TLS. Layer 4 passthrough, `stream` in nginx terms, not a
`proxy_pass` on an HTTP server block.

The gateway does not read `X-Client-Cert`, `X-SSL-Client-Cert`, or any other
forwarded certificate header, and support for one will not be added. Any proxy
able to set such a header could impersonate every agent in the fleet, which
would move the entire trust decision out of Dockplane and into whatever can
reach that port. Mutual TLS reaches this listener end to end or the deployment
is not secure.

A proxy that terminates TLS in front of the gateway breaks agent
authentication: every agent then presents the proxy's identity, or none at all.

## Not in This Layer

The gateway carries identity and liveness. It defines no capability and moves
no Docker payload. There is no shell endpoint, no exec, and no command
execution of any kind. Capabilities are added on top of a trust chain that can
already be proven, not alongside it.

## Related

- [Agent Identity](agent-identity.md)
- [Agent Protocol](agent-protocol.md)
- [Security Model](security-model.md)
