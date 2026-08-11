# Architecture

## Overview

Dockplane is a distributed Docker management system composed of:

- a public marketing/documentation surface
- an authenticated web application
- a central control server
- PostgreSQL
- a lightweight agent installed on each managed Docker host

The control server coordinates identity, authorization, state and actions. Agents perform narrowly defined host-local Docker operations.

```text
┌────────────────────────────┐
│       Public Website       │
│  Angular / prerendered     │
└────────────────────────────┘

┌────────────────────────────┐
│    Dockplane Application   │
│    Angular + TailwindCSS   │
└─────────────┬──────────────┘
              │ HTTPS
              ▼
┌────────────────────────────┐
│    Dockplane Control API   │
│           NestJS           │
│                            │
│ Auth / RBAC / Audit        │
│ Inventory / Actions        │
│ Events / Agent Control     │
└─────────────┬──────────────┘
              │
              ├──────── PostgreSQL
              │
              │ authenticated persistent channel
              ▼
┌────────────────────────────┐
│       Dockplane Agent      │
│             Go             │
│                            │
│ Docker capabilities        │
│ Host inventory / metrics   │
└─────────────┬──────────────┘
              │
              ▼
         Docker Engine
```

## Goals

- centralized Docker visibility across multiple hosts
- no central storage of SSH passwords
- outbound-friendly agent connectivity
- explicit remote capabilities
- strong device identity
- resource-scoped user authorization
- auditable operations
- clear stale/offline state
- forward-compatible agent protocol

## Connectivity

Prefer an outbound connection from each agent to the control server.

This avoids requiring a public inbound management port on every Docker host.

Agents should reconnect with bounded exponential backoff and jitter.

## State

Dockplane distinguishes:

### Observed state
Latest state reported by an agent.

### Persisted inventory
Known host/workload metadata stored by the control server.

### Action state
Lifecycle of a requested operation.

### Ephemeral telemetry
Rapidly changing metrics with potentially shorter retention.

The UI must never present stale data as current without indication.

## Action Lifecycle

Suggested states:

```text
requested
authorized
queued
dispatched
acknowledged
running
succeeded
failed
timed_out
cancelled
```

Every action receives an ID and audit context.

## Core Domain

### User
Authenticated operator.

### Role
Named permission collection.

### Host
A managed Docker host.

### Agent
Device identity associated with a managed host.

### Host Group
Logical grouping of Docker hosts.

### Container
Discovered Docker container.

### Compose Project
A discovered Docker Compose workload.

### Image
Docker image metadata relevant to managed workloads.

### Network
Docker network.

### Volume
Docker volume.

### Service
Optional higher-level grouping of related Docker workloads.

### Health Check
Configured or observed health state.

### Action
Authorized operational request.

### Event
Normalized operational event.

### Audit Entry
Security-relevant append-oriented record.

## Docker Integration

Agents should use the Docker Engine API or a maintained Go SDK.

Initial operations remain intentionally narrow.

Examples:
- list
- inspect
- start
- stop
- restart
- logs

Deleting containers, stacks or persistent volumes is not part of the safe foundation.

## Compose

Compose is modeled as a first-class workload grouping.

Dockplane should preserve:
- project name
- host
- associated containers
- labels
- discovered configuration metadata where safely available
- current state

Do not assume every container belongs to Compose.

## Services

A Service is a Dockplane-level grouping.

Example:

```text
Nextcloud
├── nextcloud
├── postgres
└── redis
```

This gives operators an application view while retaining container-level detail.

## Storage

PostgreSQL stores durable application state such as:
- users
- roles
- sessions
- hosts
- agents
- enrollment records
- inventory
- actions
- events
- audit entries
- services
- configuration metadata

High-volume telemetry may later use specialized storage if justified.

## Versioning

Version:
- REST API
- agent protocol
- migrations
- capability schema when compatibility requires it

The control server should be able to report supported/minimum agent versions.

## Trust Boundaries

Primary boundaries:
1. browser ↔ control server
2. control server ↔ database
3. control server ↔ agent
4. agent ↔ Docker daemon
5. agent ↔ host OS

Docker daemon access is privileged and must be treated accordingly.

## Failure Modes

Expected:
- agent offline
- network partition
- Docker daemon unavailable
- workload disappears between list and action
- action timeout
- version mismatch
- revoked credential
- control server restart

Failures must result in deterministic states and useful operator messages.

## Public Website Separation

The public website should be independently deployable and should not depend on the authenticated Dockplane control server.

This:
- reduces public attack surface
- keeps product/docs pages available during control-plane maintenance
- allows static hosting/CDN use
- separates release concerns
