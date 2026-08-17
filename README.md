# Dockplane

**A self-hosted control plane for managing Docker across multiple hosts.**

> Your Docker hosts. One control plane.

One place to inspect and operate Docker hosts, containers and Compose
workloads — without becoming a general-purpose infrastructure suite.

## Remote control without a remote shell

The agent exposes a fixed catalog of typed capabilities and has no way to run a
command. A request names a container or a stack and an operation from that
catalog; nothing carries a script, a shell line or input for a container. The
control server decides whether the operator may do it, and the agent checks
again before it acts.

That is a limit on Dockplane, not only on an attacker. There is no exec, no
attach and no shell on any path.

The catalog is listed in [Security Model](docs/security/security-model.md) and
[Docker Integration](docs/integrations/docker.md).

## Quick start

Install the control plane on Ubuntu 24.04, Ubuntu 22.04 or Debian 12 (amd64)
with Docker Engine and the Compose plugin. Take the current release from the
[releases page](https://github.com/Dockplanee/dockplane/releases):

```bash
VERSION=0.3.0        # the release you are installing

sha256sum -c SHA256SUMS
tar xzf "dockplane-$VERSION.tar.gz"
cd "dockplane-$VERSION"
sudo ./install-control-plane.sh --domain dockplane.example.com
```

Then sign in, and add your first Docker host from **Hosts → Add host**. That
produces one command to run on the new machine; it installs and enrolls the
agent and nothing else.

Full walkthrough: [Installation](docs/getting-started/installation.md) and
[Add a Host](docs/getting-started/add-host.md).

## What it does

### Hosts

Inventory, host metrics, health and agent state for every connected host.

A host that has been replaced can be archived: it leaves the active lists and
stops being offered as somewhere to run new work, and everything it carried
stays resolvable. Archiving is reversible. It is not a delete, not a merge and
not an agent revocation — Dockplane never decides that two host records are the
same machine, and nothing deduplicates them. See
[Archiving Hosts](docs/operations/host-archive.md).

### Containers

Every container on a connected host is listed and inspected, its output is
streamed historically and live, and it can be started, stopped and restarted.

A container Dockplane created can also be changed and removed. Changing one
replaces it, because Docker cannot change a running container's ports, mounts
or environment; the container keeps its Dockplane identity and its history. A
container Dockplane did not create keeps a read-only configuration and answers
`CONTAINER_NOT_MANAGED` to a change or a removal. Volumes are never removed,
named or anonymous. See
[Container Operations](docs/operations/container-lifecycle.md).

### Stacks

A stack is a Compose file Dockplane holds, the environment it needs, and the
host it belongs to. A value can be marked secret, and is then stored encrypted
and never shown again.

Every saved configuration is a revision, and deploying an earlier revision is
the rollback — there is no separate mechanism and no hidden snapshot.
**A rollback rolls back configuration, not data:** volumes are not touched.

A deployed stack can be started, stopped, restarted and deleted. Deleting takes
away its containers and its saved configuration; the named volumes and networks
it created stay on the host. See [Stacks](docs/operations/stacks.md).

### Compose projects found on a host

Discovered and inspected, read-only. There is no way to make Dockplane
responsible for deploying one: no adoption, no `build:`, no Git deployment, no
webhook and no automatic update. See
[Compose Support](docs/reference/compose-support.md).

### Operators and the deployment

Accounts, roles, backend-enforced permissions, sessions, TOTP second factors and
recovery codes. Audit history, backup and restore, and an upgrade that applies
the migrations it needs.

## The interface

The management lists and the settings page adapt to the width they are given: a
full table where everything fits, a compact one that keeps what somebody needs
to act, and a stacked list below a tablet's width. What an operator cannot act
without — what the thing is, which host it belongs to, what state it is in, and
the way to act on it — is in the window at every width.

## Versions

Settings reports the control server's release and commit, the browser
application's own release and commit, the schema the database has reached, the
agent protocol range, and what the enrolled agents report. The server and the
application are two images and are reported as two.

A fleet part-way through a rollout is marked as running mixed versions rather
than as broken. An agent whose protocol is outside the accepted range is
reported as an incompatibility; one that has never reported a readable version
is counted as unknown rather than as out of date.

Dockplane can also check the project's public release listing and say whether
something newer exists. It is off until an administrator turns it on, it
carries nothing about the installation, and nothing acts on the answer: there
is no auto-updater and no agent auto-upgrade. See
[Versions](docs/operations/versions.md).

## Upgrading

The installer is the upgrade. Upgrade the control plane first, then the agents:
an agent on an older release goes on working for as long as its protocol
version is one the control server accepts.

Stack management is the exception. An agent older than the release that
introduced stack attribution cannot serve stack operations, and they are
refused for that host with `AGENT_UPGRADE_REQUIRED` before anything is sent to
it. That host goes on serving inventory, metrics, logs, container operations
and Compose discovery, and its containers stay individually manageable.
Upgrading the agent is the whole repair. See
[Upgrading](docs/operations/upgrade.md) and [Stacks](docs/operations/stacks.md).

## Backup

The backup command takes the control plane's own state: the database, the
application encryption key, the agent certificate authority, Caddy's
certificates and the deployment's settings. It runs against a live deployment.

It does not back up anything on a managed host — not your containers, not their
volumes, not their data, and not a database a workload runs. Back those up as
you did before Dockplane. See
[Backup and Restore](docs/operations/backup-restore.md).

## Supported platforms

| | |
| --- | --- |
| Control plane | Ubuntu 24.04, Ubuntu 22.04 or Debian 12, amd64 |
| Managed hosts | Debian 12, Ubuntu 24.04 or Ubuntu 22.04, with systemd and Docker Engine |
| Browsers | current Firefox, Chrome, Edge and Safari |

Ports: 80 and 443 for browsers, and 9443 for the agent gateway, which
terminates its own mutual TLS and must not be proxied. The REST API (3000) and
PostgreSQL (5432) are not published.

**arm64 is experimental.** Packages, binaries and images are built for it and
inspected, and no arm64 machine has run them. Use amd64 in production. See
[Supported Platforms](docs/reference/supported-platforms.md).

## Deliberately not implemented

Exec, attach, a shell, and any other way to run a command on a managed host.
Administration of the host operating system: nothing reboots a machine,
installs a package or changes a system setting. What Dockplane changes on a
host it changes through the Docker Engine. Image management, and volume or
network operations: an image is pulled only as part of creating or replacing a
container or deploying a stack, and only when the host does not already have it.

Deliberately out of scope: Proxmox, Kubernetes, virtual machines, network
devices, and Linux servers in general.

Other things are not built yet: a Compose project found on a host cannot be
taken over, two host records are never merged, a stack's networks outlive it.
Read [Known Limitations](docs/reference/known-limitations.md) before
deploying, and [Product Scope](docs/product/PRODUCT_SCOPE.md) for the line
between a decision and a gap.

## Documentation

**[docs/](docs/README.md)** is the documentation. Start with:

| | |
| --- | --- |
| [Overview](docs/getting-started/overview.md) | what Dockplane is, and what it is not |
| [Installation](docs/getting-started/installation.md) | put the control plane on a machine |
| [Add a Host](docs/getting-started/add-host.md) | connect a Docker host |
| [Container Operations](docs/operations/container-lifecycle.md) | create, change, remove and run containers |
| [Stacks](docs/operations/stacks.md) | Compose configuration, revisions and deployment |
| [Archiving Hosts](docs/operations/host-archive.md) | taking a superseded host out of the lists |
| [Versions](docs/operations/versions.md) | what a deployment is running, and the optional check |
| [Upgrading](docs/operations/upgrade.md) | move to a newer release |
| [Backup and Restore](docs/operations/backup-restore.md) | what to keep |
| [Troubleshooting](docs/operations/troubleshooting.md) | when something is wrong |
| [Architecture](docs/reference/architecture.md) | how the pieces fit |
| [Known Limitations](docs/reference/known-limitations.md) | what this release does not do |

## Security

| | |
| --- | --- |
| [Security Model](docs/security/security-model.md) | trust boundaries and capabilities |
| [Agent Security](docs/security/agent-security.md) | enrollment, identity, revocation |
| [Authentication](docs/security/authentication.md) | sessions, MFA, permissions, audit |

Report a vulnerability privately through
[GitHub's private vulnerability reporting](https://github.com/Dockplanee/dockplane/security/advisories/new).
Please do not open a public issue for an exploitable problem. See
[SECURITY.md](SECURITY.md).

## Repository layout

```text
api/        control server (NestJS, PostgreSQL)
app/        control-plane interface (Angular)
agent/      host agent (Go)
website/    public website (Angular, prerendered)
deploy/     installer, release and packaging scripts
docs/       the documentation
```

The website is built and deployed independently of the control server.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), and
[running locally](docs/development/running-locally.md) to get the control
server up from source.

## License

Free software under the GNU Affero General Public License version 3 only
(`AGPL-3.0-only`). The full text is in [LICENSE](LICENSE).

Running a modified Dockplane as a network service means offering its users the
corresponding source. That is the point of the AGPL and the reason it was
chosen for a self-hosted control plane.
