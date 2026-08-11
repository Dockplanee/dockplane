# Dockplane Website Copy

The public website uses English as its primary language.

Copy should be adjusted only when product behavior changes.

# Homepage

## Hero

Eyebrow:

```text
SELF-HOSTED DOCKER MANAGEMENT
```

Heading:

```text
Your Docker hosts.
One control plane.
```

Body:

```text
Manage containers, Compose stacks, logs, health and operations across your Docker hosts from one secure, self-hosted interface.
```

Supporting line:

```text
Self-hosted · Multi-host · Security-first
```

Primary CTA:

```text
Get Started
```

Secondary CTA, only when the destination exists:

```text
View Source
```

## Value

Heading:

```text
Docker operations without host hopping.
```

Body:

```text
Stop jumping between SSH sessions and separate Docker endpoints. Dockplane gives connected hosts one consistent operational interface while keeping execution local to each machine through its agent.
```

### All hosts in one place

```text
See workloads, health and resource state across every connected Docker host.
```

### Operate safely

```text
Start, stop and restart workloads through defined agent capabilities with backend-enforced permissions and audit history.
```

### Stay self-hosted

```text
Run Dockplane on infrastructure you control. Your operational control plane does not need to depend on an external management SaaS.
```

## Multi-Host

Heading:

```text
Built for more than one Docker host.
```

Body:

```text
Dockplane treats distributed Docker environments as the default. See host state, workload counts, agent status and health signals without opening a separate management session for every machine.
```

## Compose

Heading:

```text
Your Compose stacks, wherever they run.
```

Body:

```text
Understand which containers belong together, inspect their current state and manage Compose workloads without reducing every application to an unrelated list of containers.
```

## Operational Context

Heading:

```text
Know what is happening before you touch it.
```

Body:

```text
Inspect logs, resource usage, health state and recent events before performing an operational action. Dockplane keeps the context close to the workload you are managing.
```

## Security

Heading:

```text
Remote control without a remote shell.
```

Body:

```text
Dockplane agents expose defined operational capabilities instead of an unrestricted command interface. Device identity, encrypted communication, authorization and audit history are part of the architecture from the start.
```

### Unique agent identity

```text
Each enrolled host uses its own agent identity and can be revoked independently.
```

### Explicit capabilities

```text
Operations such as restarting a container or reading logs use defined and validated actions.
```

### Resource permissions

```text
Backend-enforced permissions decide who can perform which operations on which resources.
```

### Auditable changes

```text
Infrastructure mutations and security-relevant actions are recorded with actor, target and result context.
```

CTA:

```text
Read the security model
```

## Self-Hosted

Heading:

```text
Your control plane belongs on your infrastructure.
```

Body:

```text
Dockplane is designed to run on systems you control and to operate without a mandatory external management service.
```

### Self-hosted

```text
Deploy and operate the control plane yourself.
```

### Understandable

```text
The architecture, permissions and agent trust model are documented instead of being hidden behind a remote service.
```

### Docker-focused

```text
Dockplane focuses on Docker operations instead of becoming a generic datacenter control panel.
```

## Final CTA

Heading:

```text
Bring your Docker hosts together.
```

Body:

```text
Deploy Dockplane and manage your Docker environment from one self-hosted control plane.
```

Primary CTA:

```text
Get Started
```

# Product Page

## Hero

Heading:

```text
Docker management built around multiple hosts.
```

Body:

```text
Dockplane brings Docker hosts, containers, Compose workloads and operational context into one self-hosted management experience.
```

## Hosts

Heading:

```text
One view of every connected host.
```

Body:

```text
See host connectivity, Docker version, agent state, workload counts and key resource signals without switching between machines.
```

## Containers

Heading:

```text
Operate containers with context.
```

Body:

```text
Inspect container state, image, health, resource usage and logs before using controlled lifecycle actions such as start, stop or restart.
```

## Compose

Heading:

```text
Keep application context intact.
```

Body:

```text
Dockplane treats Compose projects as grouped workloads so you can understand which containers belong together while keeping container-level detail available.
```

## Logs and Events

Heading:

```text
Follow what changed.
```

Body:

```text
Use workload logs, normalized events and action history to understand what happened and verify the result of an operation.
```

## Permissions and Audit

Heading:

```text
Operational access without all-or-nothing permissions.
```

Body:

```text
Dockplane is designed around backend-enforced permissions and auditable actions so operational access can be controlled more precisely than sharing a privileged host login.
```

## Docker Resources

Heading:

```text
Understand the resources behind your workloads.
```

Body:

```text
Inspect Docker images, networks and volumes across connected hosts. High-risk mutations remain deliberately constrained rather than being exposed just because the Docker API supports them.
```

# Security Page

## Hero

Heading:

```text
Security is part of the control plane.
```

Body:

```text
Dockplane manages privileged Docker operations, so identity, authorization, constrained agent capabilities and auditability are architectural requirements rather than optional add-ons.
```

## Agent Identity

Heading:

```text
Every agent has its own identity.
```

Body:

```text
Enrollment is designed around short-lived enrollment material and device-specific credentials. An individual agent can be revoked without replacing one global fleet key.
```

## Capability Model

Heading:

```text
Defined operations instead of arbitrary commands.
```

Body:

```text
The Dockplane agent accepts explicit capabilities with validated payloads. The control protocol is not designed as an unrestricted remote shell.
```

Example:

```text
container.list
container.inspect
container.start
container.stop
container.restart
container.logs
```

## Authorization

Heading:

```text
The backend is the authorization boundary.
```

Body:

```text
Hiding a button is not access control. Sensitive API operations and dispatched agent actions require backend authorization.
```

## Audit

Heading:

```text
Operational changes leave a trail.
```

Body:

```text
Security-relevant and infrastructure-mutating actions are designed to carry actor, target, result and correlation context without turning the audit log into a secret store.
```

## Docker Access

Heading:

```text
Docker access is privileged.
```

Body:

```text
Access to the Docker daemon can be equivalent to privileged host control depending on configuration. Dockplane documents that trust boundary rather than presenting Docker socket access as harmless.
```

## Secrets

Heading:

```text
Secrets do not belong in logs.
```

Body:

```text
Passwords, enrollment material, private keys, session credentials and unrestricted environment values must be excluded or redacted from normal logging and telemetry.
```

## Security Policy CTA

Heading:

```text
Found a security issue?
```

Body:

```text
Use the private security reporting process described in the project security policy.
```

Do not show a reporting address until a real private reporting channel exists.
