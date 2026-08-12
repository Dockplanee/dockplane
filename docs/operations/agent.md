# The Agent

The agent runs on each managed Docker host, natively under systemd. It is
deliberately not a container: it manages the Docker daemon it runs beside.

It reports host facts, container state and Compose projects, streams a
container's output, and starts, stops or restarts a container the control
server asks it to — one identifier per request, from a fixed catalog of
capabilities. There is no remove, exec, attach or shell, and no request the
control server can send carries a command or any input for a container.

**To add a host, use [Add a Host](../getting-started/add-host.md).** One command
does everything in the first half of this page and enrolls the host. What
follows is the reference behind it: what the package puts where, how the service
is configured, how it is upgraded and removed, how to install it by hand where
the package does not apply, and what the control plane does with an agent once
it is connected.

Examples below set `VERSION` to the release being installed. The current one
is on the [releases page](https://github.com/Dockplanee/dockplane/releases).

## Supported platforms

| | |
| --- | --- |
| Distributions | Debian 12, Ubuntu 24.04 LTS, Ubuntu 22.04 LTS |
| Architectures | linux/amd64, linux/arm64 |
| Requires | systemd, a Docker Engine reachable over its local socket, outbound access to the control server's agent gateway |

The `.deb` is the supported way to install on Debian and Ubuntu. Elsewhere, use
the tarball and install by hand.

**arm64 is experimental.** The package and the binary are produced for both
architectures and inspected — architecture, static linking, package metadata —
but no arm64 machine has run them. Enrollment, discovery, lifecycle, live logs
and reboot have been verified on amd64 only. Emulation was not used and would
not count. Treat arm64 as unproven.

## Install

```bash
VERSION=0.1.0

sha256sum -c SHA256SUMS
sudo dpkg -i "dockplane-agent_${VERSION}_amd64.deb"
```

The package installs the binary and the unit and creates the service account,
then stops. **It enrolls nothing and starts nothing**: a host with no identity
has nothing to connect with, and starting it would produce a failure the
operator did not cause.

Starting it before enrolling is harmless and says so:

```text
this host is not enrolled; run: dockplane-agent enroll --server <url>
```

The service exits with code 4 and stays stopped, rather than retrying every few
seconds until someone notices.

## Docker socket access

The unit gives the service account membership of the `docker` group, which is
how the agent reaches the Engine API.

**Membership of the `docker` group is equivalent to root on this host.**
Anything able to talk to the Docker daemon can start a privileged container
that mounts the host filesystem. This is unavoidable for managing Docker, and
it is the reason the agent has no way to run a command: the set of operations
is fixed at build time, and the three that change anything — start, stop and
restart — take a container identifier and nothing else.

The package neither creates the `docker` group nor depends on a particular
Docker package, because there is more than one legitimate way to install Docker
Engine. If the group is missing at install time the package says so, and the
service will not start until Docker is present.

Do not expose the Docker daemon over unauthenticated TCP as an alternative.

## Enroll

Create a short-lived enrollment token in Dockplane, then hand it to the agent
as the account the service runs as:

```bash
sudo -u dockplane-agent DOCKPLANE_AGENT_STATE_DIR=/var/lib/dockplane-agent \
  dockplane-agent enroll --server https://dockplane.example.com --token-stdin
```

The agent generates its key pair locally, sends a certificate request and
stores the certificate it receives. The private key never leaves the host.

There is deliberately no `--token` flag: a token on the command line is visible
in the process list to every user on the machine and is written to the shell
history. The token is read from `--token-stdin`, `--token-file`, the
`DOCKPLANE_ENROLLMENT_TOKEN` environment variable, or an interactive prompt,
and it is not written to the state directory afterwards.

Before storing anything, the agent checks the issued certificate: it must match
the key it just generated, chain to the authority the server supplied, be valid
now and be usable for client authentication.

If the control server uses a private web PKI, pass `--ca /path/to/bundle.pem`.

## Start

```bash
sudo systemctl enable --now dockplane-agent
```

The host appears in Dockplane within a few seconds, and its containers and
Compose projects shortly after.

## Files

| Path | Contents | Mode |
| --- | --- | --- |
| `/usr/bin/dockplane-agent` | the binary | 0755 root |
| `/usr/lib/systemd/system/dockplane-agent.service` | the unit | 0644 root |
| `/etc/dockplane-agent/agent.env` | optional settings, a conffile | 0640 root:dockplane-agent |
| `/var/lib/dockplane-agent/` | state directory | 0700 dockplane-agent |
| `agent.key` | the private key, generated on this host | 0600 |
| `agent.crt`, `ca.crt`, `identity.json` | certificate, issuing authority, agent id | 0644 |

The state directory is created by systemd on first start and is not shipped by
the package. Certificates and the agent id are not secret; the directory is
0700 regardless, and the key is 0600 and checked to be so at every start.

Writes are atomic, and a renewed certificate replaces the working one only
after it has been verified, so an interrupted rotation leaves a usable identity
rather than a half-written one.

`dockplane-agent status` reports the stored identity, the certificate expiry
and whether the key permissions are still owner-only. `dockplane-agent version`
reports the release, the commit it was built from, the build date and the
protocol version it speaks.

## Configuration

Everything the server assigns during enrollment — the agent identity and the
gateway address — is stored with the credential and is never restated in
configuration.

| Variable | Meaning |
| --- | --- |
| `DOCKPLANE_AGENT_STATE_DIR` | State directory, `/var/lib/dockplane-agent` by default |
| `DOCKPLANE_AGENT_TRUST_BUNDLE` | Extra authority trusted for the gateway certificate |
| `DOCKPLANE_AGENT_LOG_LEVEL` | `debug`, `info`, `warn` or `error` |

Set them in `/etc/dockplane-agent/agent.env`, which the unit reads and which an
upgrade will not overwrite. No secret belongs in that file. Configuration is
validated at startup; an unusable value stops the agent with a message rather
than surfacing later as a connection that never works.

## Connection

The agent connects outbound to the gateway address it was given, presenting its
client certificate. The server's certificate is always verified — against the
system trust store, the authority received at enrollment, and any configured
bundle. There is no option to skip verification.

A lost connection is retried with exponential backoff and jitter, up to a
two-minute ceiling.

## Upgrading

```bash
sudo dpkg -i "dockplane-agent_${VERSION}_amd64.deb"
```

The identity, the private key and `/etc/dockplane-agent` survive. The host
keeps the same agent id and does not need enrolling again; a service that was
running is restarted onto the new binary, and the control server shows the new
version within seconds.

Agents and the control server are upgraded independently. An older agent keeps
working against a newer server as long as both speak the same protocol version,
which `dockplane-agent version` and `/api/v1/version` both report.

**Downgrading is supported only between versions that speak the same protocol
version.** Nothing converts an identity or a state directory back to an older
format, and this project will not claim a downgrade is safe in general.

## Removing

```bash
sudo apt remove dockplane-agent
```

Removes the binary, the unit and the enabled symlink. **The identity in
`/var/lib/dockplane-agent` is kept**, so reinstalling brings the host back with
the same agent id and no new enrollment.

```bash
sudo apt purge dockplane-agent
```

Also deletes `/var/lib/dockplane-agent` — including this host's private key —
and `/etc/dockplane-agent`, and removes the service account. This is not
reversible: the host must be enrolled again from scratch.

**Revoke the agent in Dockplane after a purge.** Its certificate stays valid
until you do, and the control plane has no way to know the host was
decommissioned.

## Installing without a package

The tarball carries the same binary, the unit and installation notes, for hosts
that are not Debian or Ubuntu:

```bash
tar xzf "dockplane-agent_${VERSION}_linux_amd64.tar.gz"
cd "dockplane-agent_${VERSION}_linux_amd64"
cat README
```

The unit expects the binary at `/usr/bin/dockplane-agent`, and the service
account has to be created by hand. Everything after that — enrolling, starting,
upgrading — is the same.

## Building from source

For development, not for deployment:

```bash
cd agent
go build -o dockplane-agent ./cmd/dockplane-agent
```

A binary built this way reports `0.0.0-dev`, which is deliberately not a
plausible release number: a development build should be recognisable in a host
inventory rather than indistinguishable from a released one. Release artefacts
are produced by `deploy/build-agent.sh` — see
[Building a Release](releases.md).


- [Docker Integration](../integrations/docker.md)

---

The rest of this page is the control plane's side: what it reads from a
connected agent, how fresh that is, and how a credential is withdrawn.

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
Content-Type: application/json

{ "reason": "decommissioned" }
```

Requires `agents.revoke`, which is deliberately separate from `agents.read` and
`agents.enroll`. The credential stops being trusted immediately, the live
connection is closed, and discovery for that agent stops.

**A reason is required.** Withdrawing a host's identity is not something the
audit trail should record as having happened for no stated cause, so the
request carries one and it is stored with the entry. A request without it is
refused with `VALIDATION_FAILED`. The interface asks for it; a caller using the
API directly has to supply it too.

A revoked agent that tries to reconnect is refused. The agent recognises the
refusal, stops retrying and exits with code 3; its systemd unit does not
restart on that code, because there is nothing to retry until the host is
enrolled again.

Revocation does not delete the host's inventory. It stops being refreshed and
is marked stale.

## Related

- [Add a Host](../getting-started/add-host.md)
- [Agent Security](../security/agent-security.md)
- [Agent Gateway](../reference/agent-gateway.md)
- [Agent Protocol](../reference/agent-protocol.md)
- [Docker Integration](../integrations/docker.md)
- [Troubleshooting](troubleshooting.md)
