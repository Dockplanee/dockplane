# Agent Identity

Every Dockplane agent has its own cryptographic identity. There is no shared
secret, no global agent key and no credential that can be copied between hosts
without being detectable and revocable on its own.

## Identity of Record

An agent is a row in the agent registry. Its identity is a client certificate
issued by the internal Dockplane agent CA:

| Property | Meaning |
| --- | --- |
| Agent ID | A UUID assigned by the control server. The certificate subject is `CN=<agent id>`. |
| Certificate fingerprint | SHA-256 over the DER encoding of the certificate. This is the lookup key. |
| Certificate serial | The serial the CA assigned, retained for audit correlation. |
| Validity window | `AGENT_CERT_TTL`, 30 days by default. |

The fingerprint is what the gateway resolves on every message. A certificate
that is not in the registry does not identify anything, even when it chains to
the agent CA and is otherwise valid.

## The Agent Never Names Itself

Nothing an agent sends is treated as an identity claim:

- The gateway protocol has no field that names an agent.
- The hostname supplied during enrollment is a display label only.
- The subject common name in a certificate request is discarded; the CA issues
  the subject it has decided on.

Identity is derived from the certificate that completed the TLS handshake and
from nothing else. This holds for the first message and for every message after
it, so an agent cannot become another agent partway through a connection.

## Internal Agent Certificate Authority

The agent CA is separate from any public web PKI. It exists only to sign agent
client certificates, and browsers never see it.

Create it once per deployment:

```bash
npm run setup:agent-ca -- ./pki dockplane.example.com
```

The command writes the CA certificate and key, plus a gateway server
certificate, and refuses to overwrite existing material — replacing the CA
would invalidate every enrolled agent at once.

The control server reads the CA at startup from `AGENT_CA_CERT_PATH` and
`AGENT_CA_KEY_PATH` and fails to start if either is unreadable. The key may be
encrypted with `AGENT_CA_KEY_PASSPHRASE`. Startup warns when the key file is
readable by group or other.

Handle the CA key as the most sensitive material in the deployment: whoever
holds it can mint an identity for any agent.

## Certificate Requests

A certificate request is a request, not an instruction. The CA validates it
before signing:

- PEM structure and a self-signature that verifies
- At most 8 KiB
- ECDSA on P-256, P-384 or P-521, or RSA with at least 2048 bits
- No basic constraints, key usage, extended key usage, subject alternative
  names, name constraints, policy constraints or certificate policies

The extension rules matter more than they look. A request carrying
`basicConstraints: CA=true` would otherwise ask Dockplane to sign a second
certificate authority; one carrying a subject alternative name could claim a
server identity. Both are refused, at enrollment and at renewal alike.

The issued certificate is fixed by the CA: `CN=<agent id>`, client
authentication only, no CA rights.

## Revocation

Revoking an agent marks the registry row. Trust lives in the database, not in
the socket, so a revocation takes effect immediately:

1. The record is updated and the reason and actor are audited.
2. The live connection, if any, is closed.
3. A reconnect fails, because the fingerprint now resolves to a revoked agent.

Even a connection that somehow survived step 2 fails on its next message, since
identity is re-resolved every time rather than cached from the handshake.

Revocation is permanent for that credential. A host that should return is
enrolled again and receives a new identity.

## Renewal

An agent rotates its own certificate over its authenticated connection by
sending a new certificate request. Renewal deliberately accepts no enrollment
token: the proof of identity is the certificate that authenticated the
connection the request arrived on.

The agent ID is carried over unchanged and the new certificate replaces the old
one in the registry. The superseded certificate stops resolving to an identity
at that moment, even though it remains cryptographically valid until it expires.

`AGENT_CERT_RENEW_BEFORE` (7 days by default) sets the window in which an agent
should renew. The server states the resulting instant as `renewAfter` in its
handshake and renewal replies, so the policy belongs to the deployment rather
than to each agent. An agent that lets its certificate expire must be enrolled
again.

## Related

- [Agent Gateway](agent-gateway.md)
- [Agent Protocol](agent-protocol.md)
- [Security Model](security-model.md)
- [Agent Enrollment](../administration/agent-enrollment.md)
