# Dockplane Product Scope

What belongs in Dockplane, what is direction, and what stays outside. This is
the file a proposed feature is measured against.

It is not a description of the current release. Where an area is in scope but
not built, it says so; what a given release actually does is in
[Known Limitations](../reference/known-limitations.md) and the release notes.

## Product Statement

Dockplane is a self-hosted multi-host Docker control plane.

It gives operators one interface for inspecting and operating Docker
environments distributed across multiple Linux hosts.

## Primary Audience

- self-hosters with multiple Docker hosts
- homelab operators
- developers operating their own Docker infrastructure
- small technical teams
- system administrators managing Docker across several machines

## Core Problem

As the number of Docker hosts grows, operators end up:

- switching between SSH sessions
- running Docker commands by hand
- opening separate dashboards
- piecing health together from logs
- without a single action and audit history
- granting permissions inconsistently

Dockplane centralizes that operational experience while keeping host-local
execution constrained to the agent.

## Core Product Areas

### Hosts

- enrollment
- online/offline state
- inventory
- CPU, memory and disk for the host itself
- Docker version
- agent version
- workload counts
- archiving a superseded host, and restoring it

A host is never deleted, and two host records are never merged.

### Containers

- list
- inspect
- state and health
- historical and live logs
- start, stop, restart
- create, change and remove the ones Dockplane created

Ownership decides what is offered. A container Dockplane created carries the
configuration Dockplane holds for it; a container it discovered is read and run
but not edited; a container that belongs to a stack is configured by that stack.

### Stacks

- a stored Compose configuration and the environment it needs
- values marked secret, stored encrypted
- immutable revisions
- deploy, and deploy an earlier revision as a configuration rollback
- start, stop, restart and delete a deployed stack

A rollback restores configuration. It does not restore data, and volumes are
not removed.

### Compose Projects Found on a Host

- project discovery
- associated containers
- project state
- inspection

Read-only. Taking over a discovered project is adoption, and adoption is
direction rather than product today.

### Versions

- what each component of the deployment is running
- the schema the database has reached
- the agent protocol range
- what every enrolled agent reports, including a fleet on more than one version
- an optional check for a newer published release, off unless an administrator
  turns it on

Nothing updates itself. There is no auto-updater and no agent auto-upgrade.

### Security and Administration

- local users
- MFA
- roles
- permissions enforced by the backend, granular by operation
- sessions
- agent enrollment and revocation
- audit history for security-relevant and infrastructure-changing actions

### Operational Context

- events
- health state
- action history
- correlation/request IDs
- clear stale-state indicators

## Direction

In scope for the product, not built today. Nothing here is promised for a
particular release, and none of it may be presented as available.

- read access to images, networks and volumes, with destructive operations
  withheld
- per-container metrics; metrics are host-level today
- host groups
- permission scopes narrower than the whole environment: a host, a group or a
  service
- image update detection
- controlled, auditable update workflows
- backup and restore integration around known workloads
- notifications
- maintenance windows
- safe runbooks built from existing capabilities
- dependency visualization
- service-level health
- registries

### Service Abstraction

Dockplane may group related Docker workloads into a higher-level service:

```text
Nextcloud
├── nextcloud
├── postgres
└── redis
```

This adds an application-level view. It does not replace container or Compose
detail, and it is not part of the product today.

Future capabilities must remain Docker-centric.

## Explicit Non-Goals

Dockplane is not intended to become:

- a Proxmox control panel
- a Kubernetes dashboard
- a VM manager
- a Pterodactyl panel
- a general SSH fleet manager
- a generic cloud provider control plane
- a network-device controller
- an unrestricted remote shell platform

## Product Language

Preferred:

- host
- Docker host
- agent
- capability
- container
- stack
- revision
- Compose project
- workload
- service
- action
- event
- health
- control plane
- audit log

Avoid infrastructure terminology broad enough to imply platforms Dockplane does
not support.

## Related

- [Known Limitations](../reference/known-limitations.md)
- [Security Model](../security/security-model.md)
- [Overview](../getting-started/overview.md)
