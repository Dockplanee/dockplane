# Dockplane Product Scope

## Product Statement

Dockplane is a self-hosted multi-host Docker control plane.

It gives operators one interface for inspecting and operating Docker environments distributed across multiple Linux hosts.

## Primary Audience

- self-hosters with multiple Docker hosts
- homelab operators
- developers operating their own Docker infrastructure
- small technical teams
- system administrators managing Docker across several machines

## Core Problem

As the number of Docker hosts grows, operators often end up:
- switching between SSH sessions
- running Docker commands manually
- opening separate dashboards
- piecing together health from logs
- lacking a unified action/audit history
- managing permissions inconsistently

Dockplane centralizes that operational experience while keeping host-local execution constrained to the agent.

## Core Product Areas

### Hosts
- enrollment
- online/offline state
- inventory
- CPU
- memory
- disk
- Docker version
- agent version
- workload counts

### Containers
- list
- inspect
- start
- stop
- restart
- logs
- state
- health
- basic resource metrics

### Compose
- project discovery
- associated containers
- project state
- inspection
- safe lifecycle operations when implemented

### Docker Resources
- images
- networks
- volumes

Early releases may expose some resource types read-only until safe operation patterns exist.

### Security and Administration
- local users
- MFA
- roles
- resource-scoped permissions
- sessions
- agent enrollment/revocation
- audit history

### Operational Context
- events
- health state
- action history
- correlation/request IDs
- clear stale-state indicators

## Service Abstraction

Dockplane may group related Docker workloads into a higher-level Service.

Example:

```text
Nextcloud
├── nextcloud
├── postgres
└── redis
```

This does not replace container/Compose detail. It adds an application-level view.

## Future Capabilities

Possible later capabilities include:
- image update detection
- controlled update workflows
- backup/restore integration
- notifications
- maintenance windows
- safe runbooks
- dependency visualization
- service-level health
- registries

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
- container
- Compose project
- workload
- service
- action
- event
- health
- control plane

Avoid unnecessarily broad infrastructure terminology that implies unsupported platforms.
