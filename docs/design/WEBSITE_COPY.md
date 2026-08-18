# Dockplane Website Copy

The approved copy for the public website. The website is the implementation of
this file; where the two disagree, one of them is wrong and the disagreement is
worth resolving before either is released.

The primary language is English. Copy changes when product behaviour changes,
or when the same behaviour can be stated more clearly. It does not change to
make the product sound larger than it is.

Two things on the site are not written here, because writing them twice would
create a second version of the same list:

- The feature catalogue on the features page, which lives in
  `website/src/app/pages/features/feature-catalog.ts` and follows
  [Product Scope](../product/PRODUCT_SCOPE.md).
- The documentation index and the changelog, which are generated on every build
  from `docs/` and `CHANGELOG.md`.

Sections below are numbered as they are numbered on the page.

# Homepage

## Hero

Eyebrow:

```text
Self-hosted Docker management
```

Heading, on two lines:

```text
Your Docker hosts.
One control plane.
```

Body:

```text
Manage containers, Compose stacks, logs, health and operations across your Docker hosts from one interface, on infrastructure you run yourself.
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

## 01 Operations

Heading:

```text
Docker operations without host hopping.
```

Body:

```text
Stop moving between SSH sessions and separate Docker endpoints. Every connected host is managed from the same interface, and the work still happens on the machine itself, through its agent.
```

### All hosts in one place

```text
See workloads, health and resource state across every connected Docker host.
```

### Operate safely

```text
Run, create, change and remove workloads through defined agent capabilities, with backend-enforced permissions and audit history.
```

### No inbound port

```text
Each Docker host runs one small service that connects outward to the control plane, so managing a host does not mean opening a port on it.
```

Scoped to the management path. This is not a claim about a host's network
exposure in general.

## 02 Multi-host

Heading:

```text
Built for more than one Docker host.
```

Body:

```text
Host state, workload counts, agent status and health signals are in one list, without a separate management session per machine. A host that has been replaced can be archived, which takes it out of the working lists without losing what it ran.
```

## 03 Stacks

Managed stacks and discovered Compose projects are two different things, and
the homepage is the first place that distinction has to survive.

Heading:

```text
A Compose file, its history, and the host it runs on.
```

Body:

```text
A managed stack keeps its Compose configuration, the environment it needs and every revision it has had, so deploying an earlier one is the rollback. Compose projects already running on a host are discovered and grouped alongside them, and stay read-only.
```

## 04 Operational context

Heading:

```text
Know what is happening before you touch it.
```

Body:

```text
Read a workload's state, its health, its output and the events around it before you act on it. The context sits beside the thing you are managing rather than in a separate tool.
```

## 05 Security

Heading:

```text
Remote control without a remote shell.
```

Body:

```text
An agent exposes a fixed set of operational capabilities and no way to run a command. Each host holds its own identity, the channel between it and the control plane is encrypted, and the control server authorizes an action before any agent is asked to perform it.
```

### Unique agent identity

```text
Each enrolled host uses its own agent identity and can be revoked independently.
```

### Explicit capabilities

```text
Operations such as restarting a container or reading logs use defined and validated actions.
```

### Permissions by operation

Permissions are per operation. They apply across the environment; scoping them
to a host or a group is on the features page as planned, and must not be
implied here.

```text
Backend-enforced permissions decide who may perform which operations. Restarting a container and removing one are separate grants.
```

### Auditable changes

The audit trail covers security-relevant and infrastructure-changing actions.
It is not a record of every request, and no copy may say that it is.

```text
Security-relevant and infrastructure-changing actions are recorded with actor, target and result context.
```

CTA:

```text
Read the security model
```

## 06 Versions

Heading:

```text
What is running, and what is not updating itself.
```

Body:

```text
Settings reports the control server, the browser application, the database schema, the agent protocol range and what every enrolled agent reports. A fleet part-way through a rollout is marked as running mixed versions rather than as broken.
```

### No self-updating

```text
Dockplane can check the public release listing and say whether something newer exists. It is off until an administrator turns it on, and nothing acts on the answer.
```

### Upgrade in your own order

```text
Upgrade the control plane first, then the agents. An older agent keeps working while its protocol version is one the server accepts.
```

### Usable at the width you have

```text
The management lists and settings adapt to the space they are given, down to a stacked list below a tablet's width.
```

## 07 Self-hosted

Heading:

```text
Your control plane belongs on your infrastructure.
```

Body:

```text
Dockplane runs on systems you control and works without an external management service.
```

### No vendor account

```text
There is no service to sign up for and no tenant at a provider. The accounts Dockplane knows about are the ones you create in your own installation.
```

Dockplane has local accounts, roles, sessions and second factors. Copy about
self-hosting must not read as though it had none.

### Understandable

```text
The architecture, permissions and agent trust model are documented instead of being hidden behind a remote service.
```

### Scoped to Docker

```text
What Dockplane manages is Docker and its immediate operational environment. It is not on its way to becoming a datacenter panel.
```

## Final CTA

Used unchanged at the foot of the homepage, the product page and the features
page.

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
Docker hosts, containers, Compose workloads and the operational context around them, in one self-hosted control plane.
```

## 01 Hosts

Heading:

```text
One view of every connected host.
```

Body:

```text
Connectivity, Docker version, agent state, workload counts and the host's own CPU, memory and disk, without switching between machines.
```

Metrics are the host's. Per-container metrics are planned and belong on the
features page, not here.

Supporting paragraph:

```text
A host that has been replaced can be archived: it leaves the working lists and keeps everything it carried, and it can be brought back. Archiving is not a delete — no host record is removed, and none is merged with another.
```

## 02 Containers

The three ownership kinds have to stay distinguishable in every sentence on
this page:

- **external** — Dockplane did not create the container. Read and run only.
- **Dockplane-managed standalone** — Dockplane holds the intended
  configuration, so the container can also be changed and removed.
- **stack-owned** — the configuration belongs to the stack, so the container is
  not edited on its own.

Heading:

```text
Operate containers with context.
```

Body:

```text
Read a container's state, image, health and logs before acting on it. Every container on a connected host can be started, stopped and restarted; the ones Dockplane created can also be changed and removed.
```

### State and health

```text
Current state, health check result and the image a container is running.
```

### Run state

```text
Start, stop and restart map to defined agent capabilities rather than free-form commands.
```

### Create and change

```text
Define a container and edit it later. Editing replaces it and keeps its identity and history, and volumes are never removed.
```

Supporting paragraph:

```text
A container Dockplane did not create keeps a read-only configuration: its environment is deliberately not read back off a host, so there is nothing to edit from. It can still be inspected, followed and run.
```

## 03 Stacks

Heading:

```text
Compose files Dockplane keeps, and Compose projects it finds.
```

Body:

```text
A managed stack is a Compose file Dockplane holds, with its environment, its encrypted values and every revision it has had. Deploying an earlier revision is the rollback — it restores configuration, not volumes.
```

Rollback is a configuration rollback. Copy may not call it a data rollback or a
volume rollback anywhere.

Supporting paragraph:

```text
A Compose project already running on a host is a different thing: it is discovered, inspected and grouped, and it stays read-only. Dockplane does not take one over.
```

A discovered project is never described as adopted, deployed, built from
source, updated automatically or driven by Git or a webhook.

## 04 Logs and events

Heading:

```text
Follow what changed.
```

Body:

```text
Workload logs, normalized events and action history, so you can read what happened and check an operation against what it reported.
```

## 05 Permissions and audit

Heading:

```text
Operational access without all-or-nothing permissions.
```

Body:

```text
Permissions are enforced by the backend, and security-relevant and infrastructure-changing actions are recorded in the audit trail. Operational access can be granted more precisely than by handing out a privileged host login.
```

Example permission keys are shown beside this section. Every key rendered on
the site exists in `api/src/rbac/permissions.ts`; a plausible key that nobody
can grant reads exactly like a real one.

## 06 Versions

Heading:

```text
Know what this deployment is running.
```

Body:

```text
The control server and the browser application are two images and report themselves as two. Alongside them: the database schema, the agent protocol range, and what every enrolled agent reports.
```

### Mixed agent versions

```text
A fleet part-way through a rollout is marked as mixed rather than as broken. An older agent keeps working while its protocol version is one the server accepts.
```

### States worth naming

```text
An agent outside the accepted protocol range is reported as an incompatibility. One that has never reported a readable version is counted as unknown, not as out of date.
```

### An update check you switch on

```text
Dockplane can ask the public release listing whether something newer exists. It is off until an administrator turns it on, and nothing acts on the answer: there is no auto-updater and no agent auto-upgrade.
```

## 07 Interface

Four captures from a running installation, shown alongside the curated
interface previews rather than in place of them. The hosts, workloads and
stacks in them are synthetic; the interface is not, and the copy says so.

Heading:

```text
Dockplane, as it actually looks.
```

Body:

```text
Four views from a running installation. The hosts, workloads and stacks in them are made up for the picture; the interface around them is not.
```

Captions:

```text
Overview
Hosts
A managed stack
Agents and their versions
```

Each screenshot carries alternative text describing what the view shows, since
the picture is the content.

## 08 Scope

Heading:

```text
A Docker control plane, not a datacenter suite.
```

Body:

```text
Dockplane stays inside the Docker operating model. The full capability list, the planned direction and the parts that stay outside the product are set out on the features page.
```

The panel beside it lists what is in scope today. Anything not yet built belongs
on the features page under the planned heading, never in this list.

# Features Page

Heading:

```text
Everything Dockplane manages, area by area.
```

Body:

```text
Dockplane is deliberately scoped to Docker and its direct operational environment. What belongs to the product, what is planned and what stays outside it are all set out below.
```

The areas, their entries, the planned list and the out-of-scope list are the
catalogue in `website/src/app/pages/features/feature-catalog.ts`. Three rules
govern it:

1. An entry in an area describes something the release does. If it does not,
   it belongs under **Planned, not available**.
2. The planned section carries no dates.
3. The out-of-scope list is the product boundary from
   [Product Scope](../product/PRODUCT_SCOPE.md) and is not softened into
   "not yet".

Planned section:

```text
Planned, not available.
```

```text
These capabilities are part of the product direction. They are listed separately so the current boundary stays unambiguous.
```

Boundary section:

```text
What Dockplane does not do.
```

```text
Dockplane manages Docker across hosts. Broadening it into a general infrastructure suite would weaken both the security model and the product.
```

# Security Page

The most conservative page on the site. Nothing here may be strengthened for
rhythm.

## Hero

Heading:

```text
Security is part of the control plane.
```

Body:

```text
Managing Docker on a machine is a privileged operation. Every host holds its own identity, the control server authorizes each action, the agent can perform only the operations it was built with, and what changes is recorded.
```

## 01 Agent identity

Heading:

```text
Every agent has its own identity.
```

Body:

```text
A host enrolls with a short-lived token and comes away with a credential of its own. An individual agent can be revoked without replacing one global fleet key.
```

The enrollment lifecycle is listed as steps:

```text
An administrator creates a short-lived enrollment token.
The agent enrolls over authenticated TLS.
The agent receives its own device-specific credential.
Ongoing communication uses a device-authenticated encrypted channel.
A single agent credential can be revoked without replacing the others.
Enrollment and revocation are recorded in the audit history.
```

## 02 Capability model

Heading:

```text
Defined operations instead of arbitrary commands.
```

Body:

```text
The agent accepts a fixed catalogue of named capabilities with validated payloads, decided when it was built. A request names a container or a stack and an operation from that catalogue; none of them carries a command, an argument list or input for a container.
```

Supporting paragraph:

```text
There is no exec, no attach and no shell on any path, and nothing that administers the host itself — nothing reboots a machine, installs a package or changes a system setting. What Dockplane changes on a managed host it changes through the Docker Engine: containers, and the stacks made of them.
```

Beside it, the capability flow visual shows an example subset of real capability
names and the page links to the full catalogue in
[Security Model](../security/security-model.md), which is where the catalogue is
maintained. The example is currently:

```text
host.metrics
container.inspect
container.logs
container.restart
container.replace
stack.deploy
```

Every name shown anywhere on the site has to be one the agent actually
implements. An illustration of the shape of a capability name is not acceptable:
a name nobody can dispatch reads exactly like one that works.

"Nothing changes on the host" is wrong and must not come back: container and
stack state is changed, through the Docker Engine.

## 03 Authorization

Heading:

```text
The backend is the authorization boundary.
```

Body:

```text
Hiding a button is not access control. Sensitive API operations and dispatched agent actions require backend authorization.
```

Supporting paragraph:

```text
Permissions are granular by operation: reading a container, following its output, changing it and removing it are separate grants, so an operator who should be able to restart a stuck service does not also have to be able to delete one. They apply across the environment today; scoping them to a single host or group is planned, not present.
```

## 04 Audit

Heading:

```text
Operational changes leave a trail.
```

Body:

```text
Security-relevant and infrastructure-changing actions are recorded with actor, target, result and correlation context, without turning the audit log into a secret store.
```

Reads are not fully audited. No page may claim that every operation, every
request or every permitted action is recorded.

## 05 Docker access

Heading:

```text
Docker access is privileged.
```

Body:

```text
Access to the Docker daemon can be equivalent to privileged host control depending on configuration. Dockplane documents that trust boundary rather than presenting Docker socket access as harmless.
```

```text
An unauthenticated Docker TCP endpoint is not an acceptable way to simplify agent deployment.
```

## 06 Secrets

Heading:

```text
Secrets do not belong in logs.
```

Body:

```text
Passwords, enrollment material, private keys, session credentials and unrestricted environment values must be excluded or redacted from normal logging and telemetry.
```

## Reporting

Heading:

```text
Found a security issue?
```

Body:

```text
Report it privately rather than in a public issue. A report is most useful when it names the affected version and component, describes the impact and includes a reproduction with sanitized logs.
```

```text
Please do not disclose an exploitable issue publicly before the maintainers have had a chance to investigate and prepare a fix.
```

The reporting button is rendered only while a private reporting channel exists.

# Docs Page

Heading:

```text
Set up Dockplane and connect your Docker hosts.
```

Body:

```text
How a Dockplane deployment is put together, how the first host joins it, and where the documentation for the rest of it lives.
```

The page carries the deployment topology, the steps that connect a host, and an
index of `docs/` generated on every build. Nothing in that index is written
here; a page added, renamed or rewritten in `docs/` appears on the website
without the site being edited.

# Changelog Page

Heading:

```text
What changed in Dockplane.
```

Body:

```text
Entries describe changes from an operator perspective. Work that has not shipped is listed as unreleased until it does.
```

Entries are generated from `CHANGELOG.md`. A release without a date is rendered
as not released; the date is added when the release is published, and never
before.

# Footer

```text
A self-hosted control plane for managing Docker across multiple hosts.
```

```text
Dockplane is in active development. Releases, their notes and their checksums are published in the source repository.
```

A footer link to a destination that does not exist yet is omitted rather than
rendered dead.

# Metadata

Every route carries a document title and a description. They describe the page,
in the same voice as the page, and are not a place to repeat keywords. Titles
are rendered verbatim without an appended site suffix.

Structured data states only what the project can stand behind: that these
addresses are one site, and what the software is. A version, a release date, a
price or a rating is not decided on the website, so none of them appears there.
