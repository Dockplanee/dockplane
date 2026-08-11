# Connect the First Docker Host

A host joins Dockplane by enrolling its agent. The agent generates its own key
pair, exchanges a short-lived token for a certificate, and connects outbound to
the gateway. The private key never leaves the host.

## Before you start

Create the internal agent certificate authority once per deployment:

```bash
npm run setup:agent-ca -- ./pki dockplane.example.com
```

Point `AGENT_CA_CERT_PATH`, `AGENT_CA_KEY_PATH`, `AGENT_CLIENT_CA_CERT_PATH`,
`AGENT_GATEWAY_TLS_CERT_PATH` and `AGENT_GATEWAY_TLS_KEY_PATH` at the result,
and set `AGENT_GATEWAY_ADVERTISED_URL` to the address agents can reach.

The gateway listens on its own port, separate from the API. A proxy in front of
it must pass TCP through without terminating TLS: the client certificate is the
host's identity, and a proxy that terminated it would destroy the only thing
the gateway authenticates.

## Enroll

1. Sign in as an administrator and open **Agents**.
2. **Create enrollment token**. It is shown once, expires in ten minutes and is
   spent on first use.
3. Install the agent on the Docker host and hand it the token — see
   [Install the Agent](agent-installation.md).
4. Start the service. The host appears under **Agents** as connected, and its
   containers and Compose projects appear within a few seconds.

If enrollment fails, issue a new token. A spent or expired one cannot be reused.

## Afterwards

The agent renews its certificate over the authenticated connection before it
expires. The identity does not change: the same agent keeps the same
identifier, the key and certificate are replaced together, and the file
permissions are unchanged. Renewal is recorded in the audit trail as
`agent.certificate.renewed`.

Revoking an agent closes its connection immediately. The agent exits with code
3, and its unit does not restart on that code — restarting the service by hand
starts it, it is refused, and it exits again without ever appearing connected.
Bringing the host back requires a new enrollment.

A re-enrolled host joins as a **new** agent with a new identity. The revoked
agent and the host record it belonged to stay in the inventory as history, so
the same machine can appear more than once; the old entry is marked revoked and
every operation against it is refused.

## Related

- [Install the Agent](agent-installation.md)
- [Agent Enrollment](../administration/agent-enrollment.md)
- [Agent Identity](../architecture/agent-identity.md)
