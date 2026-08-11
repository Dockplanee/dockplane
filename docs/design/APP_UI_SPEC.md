# Dockplane Application UI

## Purpose

The authenticated application is an operational interface for managing Docker across multiple hosts.

It shares the Dockplane brand with the public website but is intentionally denser and more action-oriented.

## UX Principle

The primary flow should be:

```text
see problem → understand context → inspect target → perform safe action → verify result
```

Operators should not need to reconstruct basic Docker state across multiple unrelated screens.

## Main Navigation

Initial navigation:

```text
Overview

Docker
  Hosts
  Containers
  Compose
  Images
  Volumes
  Networks

Operations
  Events
  Actions
  Health

Administration
  Agents
  Users
  Roles
  Audit Log
  Settings
```

Only show navigation for functionality that exists.

Future features such as backups/runbooks should not occupy empty production navigation before implementation.

## App Shell

Desktop:
- persistent left sidebar
- compact top bar
- content area optimized for 1200px+
- optional contextual right panel/drawer

Mobile/tablet:
- collapsible navigation
- no desktop-only hover controls
- tables adapt to cards or horizontal scroll where appropriate

## Overview

Preferred content:

```text
Dockplane

Hosts
4 total    3 healthy    1 warning

Containers
38 running    2 stopped    1 unhealthy

Needs attention
- apps-02 disk usage 89%
- paperless-db health check failing
- docker-04 agent offline

Recent actions
- nextcloud restarted
- compose project inspected
- agent enrolled
```

Do not overload the dashboard with decorative charts.

## Host List

Columns:

```text
Host
Status
Agent
Docker
Containers
CPU
Memory
Disk
Last Seen
```

Support:
- search
- status filter
- host group filter when available
- useful sorting

## Host Detail

Header:

```text
docker-01
Healthy

Debian
Docker 28.x
Agent x.y.z
Last seen just now
```

Primary metrics:
- CPU
- memory
- disk
- load where useful

Tabs:

```text
Overview
Containers
Compose
Images
Volumes
Networks
Events
Settings
```

Avoid presenting stale data as current.

## Container List

Columns:

```text
Name
Host
Image
State
Health
CPU
Memory
Created
```

Quick actions may include:
- start
- stop
- restart
- logs

Quick actions must still pass backend authorization.

## Container Detail

Header:
- container name
- host
- state
- health
- image

Primary actions:
- Start
- Stop
- Restart
- Logs

Tabs:

```text
Overview
Logs
Metrics
Configuration
Networks
Volumes
Events
```

Secrets/environment values are redacted by default.

## Compose

Compose project list:

```text
Project
Host
Containers
Health
Updated
```

Compose detail:

```text
Nextcloud
apps-01

Containers
nextcloud
postgres
redis
```

Show project-level operations only when implemented safely.

## Logs

Log viewer should provide:
- streaming mode when supported
- pause/resume
- search/filter
- copy selected content
- timestamp visibility
- line wrapping toggle
- monospace font
- clear reconnect/error state

Do not execute arbitrary commands from a log view.

## Images

Initially may be read-only.

Show:
- repository
- tag
- image ID
- size
- created
- hosts/workloads using it
- update information only when reliable

## Volumes

Treat persistent data as high risk.

Early UI may be read-only.

Any future delete action requires:
- dedicated permission
- clear destructive confirmation
- dependency/use information
- audit entry

## Networks

Show:
- name
- driver
- scope
- attached workloads

Do not imply network-device management outside Docker.

## Events

Normalize important events:

```text
container.started
container.stopped
container.restarted
container.health.changed
agent.connected
agent.disconnected
agent.revoked
action.failed
```

Provide:
- timestamp
- host
- resource
- event
- correlation ID when useful

## Actions

Action history shows:
- action
- actor
- target
- host
- requested
- duration
- result

Action states:
- queued
- running
- succeeded
- failed
- timed out

## Confirmation Patterns

### Operational Action

Example:

```text
Restart nextcloud?

Host
apps-01

Expected interruption
Usually a few seconds

[Cancel] [Restart]
```

### Destructive Action

Must:
- clearly name affected resource
- explain consequence
- require appropriate permission
- avoid ambiguous labels

## Status Language

Use:

```text
Healthy
Degraded
Offline
Unknown
Running
Stopped
Starting
Stopping
Updating
Failed
```

Status always uses text plus icon/shape where helpful.

## Density

Website:
- generous

Application:
- compact but readable

Recommended:
- body 14–15px
- table 13–14px
- technical values may use monospace

## Keyboard

Important:
- navigation operable by keyboard
- table row actions reachable
- dialogs trap focus correctly
- Escape closes appropriate overlays
- destructive confirmations do not auto-focus the dangerous action

## Empty States

Good:

```text
No Docker hosts connected yet.

Install the Dockplane Agent on a Docker host to begin.
```

Avoid jokes or overly casual copy in operational empty states.

## Error States

Provide:
- human explanation
- stable error code when useful
- request ID for diagnostics
- retry where safe

Never show raw production stack traces.

## Theme

Use the shared brand tokens.

Dark mode is the visual lead. Light mode is first-class.
