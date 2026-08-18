# Overview

**Dockplane is a self-hosted control plane for managing Docker across multiple
hosts.**

> Your Docker hosts. One control plane.

You run it yourself. It talks to your Docker hosts through an agent you install
on each of them, over a connection the host opens outward. There is no service
to sign up for, and nothing about your hosts, your workloads or your users is
sent anywhere.

One request leaves the network if you ask for it. Dockplane can check the
project's public release listing to tell you when a newer release exists. It is
off until an administrator turns it on, it carries nothing about the
installation, and nothing acts on the answer — there is no auto-updater and no
control that installs anything. See [Versions](../operations/versions.md).

## Remote control without a remote shell

Most tools that manage servers remotely end up giving something the ability to
run arbitrary commands. Dockplane does not have that ability at all.

The agent exposes a fixed catalog of typed capabilities, decided when it was
built:

```text
host.inventory      container.list        container.start       stack.deploy
host.metrics        container.inspect     container.stop        stack.start
compose.list        container.logs        container.restart     stack.stop
compose.inspect                           container.create      stack.restart
                                          container.replace     stack.remove
                                          container.remove
```

That is the whole surface. A request names a container or a stack and an
operation from that list; there is no field, parameter or header that carries a
command, a script or input for a container. The control server decides whether
the operator may do it, and the agent checks again before it acts.

This is a limit on Dockplane, not only on an attacker. Dockplane cannot do
things to your hosts that are not on that list — and neither can anybody who
takes over the control plane.

See [Security Model](../security/security-model.md).

## What it manages

| | |
| --- | --- |
| Docker hosts | inventory, metrics, health, agent status, archiving |
| Containers | list, inspect, create, change, remove, start, stop, restart, historical and live logs |
| Stacks | a saved Compose configuration, its environment and encrypted secrets, revisions with rollback, deploy and lifecycle |
| Compose projects | found on a host: discovered and inspected, read-only |
| Operators | accounts, roles, permissions, sessions, second factors |
| The deployment | audit history, backup and restore, upgrades |

## What it is not

Dockplane manages Docker hosts. Deliberately, it does not manage:

- Proxmox, or any hypervisor
- Kubernetes
- virtual machines
- network devices
- Linux servers in general

It is not a fleet SSH tool and not a generic cloud control plane. The scope is
Docker and its immediate operational environment, and it stays there.

For the full statement, see [Product Scope](../product/PRODUCT_SCOPE.md).

## How the pieces fit

```text
Browser
   │ HTTPS, 443
   ▼
Caddy ──────► the application (static files)
   │ /api/*
   ▼
control server ──► PostgreSQL      neither is published
   │
   │ 9443, mutual TLS
   ▼
agents on managed hosts            outbound only
   │
   ▼
Docker Engine API
```

The control plane is a Docker Compose stack on one machine. The agent is a
native binary under systemd on each managed host — not a container, because it
manages the Docker daemon it runs beside.

Nothing needs to reach into a managed host. Agents connect outward and hold one
mutual-TLS connection open.

See [Architecture](../reference/architecture.md).

## Where to go next

| | |
| --- | --- |
| [Installation](installation.md) | put the control plane on a machine |
| [Add a Host](add-host.md) | connect your first Docker host |
| [Container Operations](../operations/container-lifecycle.md) | create, change, remove and run containers |
| [Stacks](../operations/stacks.md) | saved Compose configurations and their history |
| [Archiving Hosts](../operations/host-archive.md) | taking a superseded host out of the working set |
| [Upgrading](../operations/upgrade.md) | move to a newer release |
| [Backup and Restore](../operations/backup-restore.md) | what to keep, and how to come back |
| [Security Model](../security/security-model.md) | what the trust boundaries are |
| [Known Limitations](../reference/known-limitations.md) | what this release does not do |

## License

`AGPL-3.0-only`. See [LICENSE](../../LICENSE).
