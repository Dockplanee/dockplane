# Dockplane

**A self-hosted control plane for managing Docker across multiple hosts.**

> Your Docker hosts. One control plane.

One place to inspect and operate Docker hosts, containers and Compose
workloads — without becoming a general-purpose infrastructure suite.

## Remote control without a remote shell

The agent exposes a fixed catalog of typed capabilities and has no way to run a
command. A request names a container and an operation from that list; nothing
carries a script, a shell line or input for a container. The control server
decides whether the operator may do it, and the agent checks again before it
acts.

That is a limit on Dockplane, not only on an attacker.

## Quick start

Install the control plane on Ubuntu 24.04, Ubuntu 22.04 or Debian 12 with
Docker Engine and the Compose plugin. Take the current release from the
[releases page](https://github.com/Dockplanee/dockplane/releases):

```bash
VERSION=0.1.0        # the release you are installing

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

| | |
| --- | --- |
| Docker hosts | inventory, metrics, health, agent status |
| Containers | list, inspect, start, stop, restart, historical and live logs |
| Compose projects | discovered and inspected, read-only |
| Operators | accounts, roles, permissions, sessions, TOTP second factors |
| The deployment | audit history, backup and restore, upgrades that migrate |

Deliberately not implemented: remove, exec, attach, Compose deploy, image and
volume changes. Deliberately out of scope: Proxmox, Kubernetes, virtual
machines, network devices, and Linux servers in general.

See [Known Limitations](docs/reference/known-limitations.md) and
[Product Scope](docs/product/PRODUCT_SCOPE.md).

## Documentation

**[docs/](docs/README.md)** is the documentation. Start with:

| | |
| --- | --- |
| [Overview](docs/getting-started/overview.md) | what Dockplane is, and what it is not |
| [Installation](docs/getting-started/installation.md) | put the control plane on a machine |
| [Add a Host](docs/getting-started/add-host.md) | connect a Docker host |
| [Upgrading](docs/operations/upgrade.md) | move to a newer release |
| [Backup and Restore](docs/operations/backup-restore.md) | what to keep |
| [Troubleshooting](docs/operations/troubleshooting.md) | when something is wrong |
| [Architecture](docs/reference/architecture.md) | how the pieces fit |

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
