# Troubleshooting

The agent logs structured JSON to standard error, so `journalctl -u
dockplane-agent` is the first place to look. Every line carries an `event`
field; the ones named below are what to search for.

## The agent will not start

`this host is not enrolled` — the state directory holds no identity. Run
`dockplane-agent enroll --server <url>`.

A configuration error stops the agent immediately with the offending value
named. The state directory must be an absolute path, and a configured trust
bundle must exist and hold at least one certificate.

## The agent cannot connect

Look for `gateway_retry`, which reports the reason on every attempt.

| Reason | Cause |
| --- | --- |
| `certificate signed by unknown authority` | The gateway presents a certificate the agent does not trust. Pass the authority with `DOCKPLANE_AGENT_TRUST_BUNDLE`. |
| `connection refused` | Wrong address or port, or the gateway is not running. |
| `tls: bad certificate` | The gateway refused the agent's certificate. Check that the agent is still enrolled and not revoked. |
| `i/o timeout` | Blocked outbound. The agent connects out; nothing needs to reach it. |

A reverse proxy in front of the gateway must pass TCP through rather than
terminate TLS. Terminating it breaks agent authentication: every agent then
presents the proxy's identity, or none at all.

Reconnection backs off exponentially with jitter to a two-minute ceiling, so a
recovering server is not met by the whole fleet at once.

## The agent connects and is then dropped

`agent_revoked` means the credential was revoked. The agent stops and exits
with code 3, and its unit does not restart on that code. Enroll the host again
to bring it back; revocation is not reversible.

`AGENT_UNKNOWN` after a rotation means the server no longer recognises the
certificate the agent is presenting. This is normal for one reconnect
immediately after renewal. If it persists, the stored certificate and the
registry have diverged, and re-enrolling is the way back.

## Docker is unavailable

`docker_unavailable` at startup, or capabilities answering `DOCKER_UNAVAILABLE`,
mean the Engine could not be reached or refused the agent. Check that the
daemon is running and that the service account is in the `docker` group.

The agent keeps running: host inventory and metrics still answer, and the
control server keeps the last observation and marks it stale.

Do not work around a permission problem by exposing the daemon over
unauthenticated TCP.

## The control plane will not come up

This is the deployment's own Compose stack, not a stack you manage with
Dockplane. `docker compose ps` on the control-plane host shows which service
stopped. Three failures account for almost all of them:

- **`migrate` exited non-zero.** The schema change failed and the control
  server was not started, on purpose. `docker compose logs migrate` names the
  statement. The data is untouched and the failed migration is not recorded.
- **`api` exits immediately** with a configuration error naming the value it
  refused, or with "the database is missing N migration(s)" — run
  `docker compose run --rm migrate` before starting that version.
- **`caddy` restarts in a loop.** Its log names the line of the Caddyfile it
  could not parse, or the certificate it could not obtain: check that the DNS
  name in `.env` resolves to this machine and that ports 80 and 443 are
  reachable from outside.

A secret that cannot be read is reported as
`DATABASE_URL_FILE: /run/secrets/… could not be read`. The files under
`secrets/` must be readable by the uid the containers run as — 10001 by
default, not the host's first login account.

## The control server will not serve

`/health/live` answering while `/health/ready` returns 503 with
`{"checks":{"database":"unavailable"}}` means the process is fine and
PostgreSQL is not. The server does not exit and does not need restarting; it
recovers by itself when the database returns.

If both are unreachable through the proxy (502), the service itself is down:
`systemctl status dockplane-server` and `journalctl -u dockplane-server`. A
server that starts and immediately exits is nearly always a configuration
value rejected at startup, named in the last line before it stopped.

## The live log view shows nothing

A stream that connects but stays empty on a busy container is usually a proxy
buffering it. The reverse proxy must flush server-sent events as they arrive —
with Caddy, `flush_interval -1` on the API route.

## An operation answers 504 and then turns out to have worked

The proxy gave up before the host did. Stopping a container gives it its full
grace period first, so a restart legitimately takes up to 90 seconds, and a
proxy with a shorter header timeout reports a gateway error while the operation
is still running. The bundled Caddyfile allows 120 seconds
(`response_header_timeout`); a proxy in front of that one needs at least as
much.

A quiet stream is kept open by a keepalive comment every
`LOG_STREAM_KEEPALIVE_INTERVAL`. If quiet streams still drop after a fixed
interval, an idle timeout in the proxy is shorter than that value.

## A host shows stale data

A host is stale when its agent is disconnected, however recent the last
observation was, and when a connected agent has not reported for three
discovery intervals. The last known state is kept deliberately: it is what an
operator needs when a host goes quiet.

Check `agent.status` on the host record and the agent's own log.

## Containers disappeared or did not appear

Records are removed only after a discovery pass that completed in full. If
containers are missing, look for `inventory.sync.failed` events and for
`discovery_step_failed` in the server log — a pass with gaps updates what it saw
and removes nothing.

A container that never appears is usually one the agent cannot see: check that
it exists on the host the agent runs on, since Docker identity is host-scoped.

## Certificate renewal keeps repeating

If agents rotate certificates continuously and reconnect each time, check
`AGENT_CERT_RENEW_BEFORE` against `AGENT_CERT_TTL`. A renewal window at least as
long as the certificate lifetime puts the renewal instant permanently in the
past. The control server refuses that configuration at startup.

## Correlating a request

Capability requests carry an identifier that appears in the server log and in
the agent's `capability_completed` or `capability_failed` line, alongside the
capability and its duration.

## An operation is refused and the reason is on the host

A capability that fails on a host answers with a code and a sentence the
control server chose — `DOCKER_UNAVAILABLE` reads "The Docker Engine on this
host could not be reached." The host's own wording is deliberately not passed
on to the browser; it is in the control server's log against
`agent_capability_failed`, with the request identifier, the capability and the
agent.

## Stack operations on one host are refused

`AGENT_UPGRADE_REQUIRED` means that host's agent predates stack attribution, so
the control server cannot tell which of its containers belong to a stack and
refuses the operation rather than acting on a guess. Everything else on that
host keeps working. Upgrade its agent; nothing else is needed, and the host is
not re-enrolled. See [Stacks](stacks.md) and [The Agent](agent.md).

## Every operation against a host is refused

If a host is listed but nothing can be done with it, check whether its agent is
revoked. A machine that was re-enrolled appears twice: the revoked entry keeps
its containers as history and refuses every operation, while the new agent
carries the same machine under a new identity. Operate on the connected one.

## What is not in the logs

Enrollment tokens, private keys, certificate contents, container environment
values and registry credentials are never logged, by the agent or the server. If
you are looking for one of them to diagnose a problem, the answer is elsewhere.
