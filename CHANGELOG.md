# Changelog

All notable user-facing changes should be documented here.

Use release-oriented language.

Do not include internal prompt history, development conversation notes or artificial task numbering.

## 0.2.0-rc.3 — 2026-08-15

A bugfix candidate. Everything here is about the same thing: saying which host
you are looking at, and whether what is on the screen is happening now or is the
last thing anybody saw.

`0.2.0-rc.2` was not published as a release: publication stopped before any
artifact was built. This candidate carries the same fixes.

### Fixed
- A host that stops answering marks its readings as the last known ones straight away. Its containers, its Compose projects and the containers listed on a project's page do the same, so one page no longer shows workloads as running beside a host that already says it is offline.
- A host's CPU, memory and disk readings stay on its page while it is offline, labelled with when they were reported. They were being dropped entirely.
- A container whose host cannot be reached still opens. It was reported as though the container no longer existed, which sent people looking for a workload that had not gone anywhere.
- The state of such a container is shown as the last one seen rather than in the colour of a running workload, and the page says when it was observed.
- Where a host is named, the name it was given comes first and the system hostname follows it. A machine enrolled more than once leaves a host resource behind for every enrolment and they all report the same hostname, so hosts, agents, containers and stacks would all show the same word for different machines. They are now told apart everywhere, including in the deployment dialog and the stack list.
- Opening the logs of a container whose host is offline says that the live stream is unavailable, rather than reporting it as an operation that was not carried out.
- A stack on a host that is offline says what that does and does not prevent: configuration and new revisions can still be saved, and deploying waits for the host to come back. The deployment and lifecycle controls were the only thing mentioning it, each in a tooltip.
- Form fields are easier to make out before they are focused, in both themes. Several of them were drawn without a border at all in the dark theme, and the sign-in fields were drawn as a box around their label rather than around the input.
- The compiled Compose compiler is no longer kept in the repository. Building it locally rewrote a tracked file, which left the working tree modified and stamped release builds as coming from a modified source.

### Changed
- Creating a container lists every host and says which of them can be chosen. A host whose agent is offline is shown and cannot be selected, with the reason given before the form is filled in rather than after it is submitted.

### Known limitations
- Unchanged from 0.2.0-rc.1. Read [Known Limitations](docs/reference/known-limitations.md) in full before deploying.

## 0.2.0-rc.1 — 2026-08-14

Stacks: Compose workloads that Dockplane owns, deploys and can take away again.

### Added
- Stacks. Write a Compose file in Dockplane, save it, and deploy it to a host. Every save is an immutable revision, so what is saved and what is running are separate facts and the interface says which is which.
- Any saved revision can be applied, forwards or back. Rolling back is deploying an earlier revision and is named that way.
- Stack environment variables, with secrets encrypted at rest under the deployment's own key. A secret reaches the host in the deployment plan and appears in no log, no audit entry and no API response.
- Start, stop and restart a deployed stack, in dependency order, each recorded and answered with what the host was observed to be afterwards.
- Delete a stack. Its service containers are removed and its saved configuration and revision history are deleted. **Named volumes are kept and no data in them is deleted**; a deployed stack has to be named back before the action is offered.
- Standalone containers can be created, reconfigured and removed. A container keeps its Dockplane identity when Docker replaces it, so a reconfiguration is the same container rather than a new one.
- A Compose file is checked before it can be saved, and what Dockplane can deploy is stated rather than discovered on the host. See [Compose Support](docs/reference/compose-support.md).
- An operation whose outcome never came back leaves the stack blocked and is settled from the host itself. Nothing is ever dispatched twice.
- `GET /api/v1/agents/{id}` reports the capabilities each agent advertised, which is how to tell which hosts are still running an older agent during a fleet upgrade.

### Changed
- `roles.manage`, `stacks.adopt` and `stacks.secrets.reveal` are no longer in the permission catalog. Nothing enforced them, so they could be granted and conferred nothing. A custom role that had `roles.manage` loses a grant that never did anything; no other permission changes.
- The release bundle's example settings name the release they were packed with.

### Fixed
- Two builds of one commit produced different bytes. The build date is taken from the commit rather than from the clock, so a release can be rebuilt and compared.

### Security
- Stack operations are typed capabilities like every other: `stack.deploy`, `stack.start`, `stack.stop`, `stack.restart` and `stack.remove`. No Compose file, command or shell reaches a host.
- The agent refuses to act on a container it cannot prove belongs to the stack it was asked about, and a deployment stops rather than adopting a volume, network or container that carries somebody else's identity.
- A stack whose containers do not match one complete revision needs attention, and Dockplane will not operate or delete it until somebody decides what it should be.

### Known limitations
- Applying a revision recreates every service, so a stack is briefly down while it is rebuilt.
- Deleting a stack leaves its networks and its named volumes on the host.
- A Compose project discovered on a host still cannot be taken over.
- Read [Known Limitations](docs/reference/known-limitations.md) in full before deploying.

## 0.1.0 — 2026-08-12

First stable release. The product is what the four release candidates converged
on; the entries below describe it rather than repeating how it got there.

### Added
- A self-hosted control plane for Docker across multiple hosts: inventory, metrics, health and connectivity for every connected host, with stale data marked rather than presented as current.
- One-command host onboarding. Dockplane produces the command, the machine runs it, and the agent is downloaded, verified against the release checksums, installed, enrolled and started without a further step.
- Container lifecycle — start, stop and restart — each behind its own permission, recorded as an action and in the audit trail, and answered with the state observed on the host.
- Historical container output and a live stream that follows it, with stdout and stderr kept apart. Closing the view stops the read on the host.
- Compose projects discovered and inspected, read-only.
- Local accounts with TOTP second factors and single-use recovery codes, server-side sessions with revocation, and roles whose permissions the control server enforces.
- Audit history with actor, action, target, result and request context.
- Backup and restore of the database, the application encryption key, the agent certificate authority and Caddy's certificates, validated in full before a restore touches anything.
- Upgrades through the installer: a validated backup first, then the deployment's files, then the schema, then the containers, and the version marker last.
- Agents for amd64 and arm64 as Debian packages and tarballs, and multi-architecture control plane images with a bill of materials and build provenance attached.

### Security
- Typed capabilities instead of remote command execution. There is no exec, attach or shell, and no message that carries a command.
- Per-agent identity over mutual TLS, with the private key generated on the managed host and never transmitted.
- One-time, short-lived enrollment credentials, stored only as digests, that never appear in a command, an argument list or on disk.
- Individual agent revocation that drops the connection and ends any running stream.
- Container output is never stored and never audited.

### Known limitations
- Re-enrolling a machine creates a new host record; the previous one remains and stops being refreshed.
- arm64 is built and inspected; no arm64 machine has run it. Use amd64 in production.
- Backups are not encrypted by Dockplane and contain this deployment's private keys.
- Images are not signed; a bill of materials and provenance are attached instead.
- Compose projects are read-only, and container removal, volume and image management are not implemented.
- There is no automatic updater and no APT repository.

## 0.1.0-rc.4 — 2026-08-12

### Changed
- An upgrade reports a pinned agent version that is not the release being installed, and `dockplane-control doctor` reports one at any time. Without a pin, adding a host installs the agent matching the control plane, and always has; what was missing is that a pin nobody remembers setting was invisible.
- The reverse proxy image applies the distribution's own security updates, which removes five of the ten high findings against it — curl, libcurl and c-ares. The five that remain are compiled into the Caddy binary and can only be fixed by Caddy publishing a build against a newer Go toolchain.

### Fixed
- A release gate that cannot run its checks now fails instead of doing less. The asset verification compared checksums without requiring the tool that computes them, so on a machine without it both sides of the comparison were empty and matched. The build also wrote a placeholder into the release manifest when it could not determine an image digest, which satisfied every later check that only asked whether a digest was present.
- The documentation no longer tells operators to install an agent package under a name that was never published.

### Removed
- The features page no longer advertises images, networks, volumes, container metrics, host groups or resource scopes. None of them exist in this release; all six are listed as planned.

## 0.1.0-rc.3 — 2026-08-12

### Fixed
- The agent package can be downloaded from the release. It was published under a name the installer never asks for, because a tilde is rewritten in a release asset name, and adding a host failed on a missing file. The tilde belongs in the package's version field, which is not a file name.
- Multi-architecture images build reliably. The JavaScript build now runs on the machine doing the building rather than under emulation, where the toolchain wrote binaries and ran them in the same moment.

### Changed
- A release is created as a draft and published only after its assets have been fetched back from the release and checked against what was built, including the published checksum file and the version each package declares.

## 0.1.0-rc.2 — 2026-08-12

### Added
- Adding a Docker host is one command. Dockplane produces it, the machine runs it, and the agent is downloaded, verified against the release checksums, installed, enrolled and started without a further step. The command carries a short-lived single-use ticket in the request body; the credential the agent enrolls with is never visible.
- The interface reports what the control plane has observed while a host is being added — the command was run, a certificate was issued, the agent connected, the inventory arrived — and nothing that has not happened.

### Changed
- The installer is the upgrade. It recognises an existing deployment, takes a backup and refuses to continue without one, replaces the deployment's Compose file and Caddyfile with the release's, migrates the schema before replacing containers, and records the new version only once the result is serving.

### Fixed
- The search overlay was laid out on every page even when closed, which put it below the page content instead of over it.
- The installer named the release it was written for rather than the one it shipped in, so an upgrade looked for the version it was replacing.
- The pre-upgrade backup was reported without being taken. It is now created through the same command an operator uses and read back by the validation a restore performs before anything is migrated.
- An installation command that had stopped working still counted down instead of saying so.

### Known limitations
- arm64 is built and inspected; no arm64 machine has run it. Use amd64 in production.
- Backups are not encrypted and contain this deployment's private keys.
- Upgrading from 0.1.0-rc.1 uses the installer from this release; the sequence documented in 0.1.0-rc.1 never adopted a new Compose file.

## 0.1.0-rc.1 — 2026-08-11

First release candidate. Everything below is in it; see the release notes for
what is not.

### Added
- Dockplane Agent for Linux Docker hosts: explicit enrollment, an outbound mutual-TLS connection, certificate renewal and a fixed capability catalog with no command execution.
- Read-only discovery of host inventory and metrics, containers and Compose projects, with snapshot reconciliation so an incomplete pass never removes records that still exist.
- Read-only APIs for hosts, containers and Compose projects, protected by backend-enforced permissions, with pagination, filters and explicit stale and observed-at state.
- Operational events for agent connectivity, inventory changes and discovery failures, recorded on change and kept separate from the audit trail.
- Agent enrollment with single-use, short-lived tokens exchanged for per-agent client certificates issued by an internal certificate authority.
- Agent gateway on a dedicated mutual-TLS listener, where an agent's identity is derived from its client certificate rather than from anything it sends.
- Agent registry with certificate renewal over the authenticated connection, and revocation that closes a live connection and prevents reconnection.
- Control server with local authentication, server-side sessions, TOTP multi-factor authentication with single-use recovery codes, backend-enforced roles and permissions, an audit trail and health endpoints.
- Container start, stop and restart, each behind its own permission, confirmed before it runs, serialised per container, recorded as an action and in the audit trail, and answered with the container state observed on the host afterwards.
- Action history of every container operation carried out through Dockplane, with its actor, result, duration and error code.
- Live container logs: a snapshot of what a container has printed and a stream that follows it, behind a permission of its own, with stdout and stderr kept apart, bounded at every stage and honest about anything that could not be delivered. Log content is never stored, audited or written to a server log.
- Control-plane interface covering hosts, containers, Compose projects, health, actions, agents, users, roles and the audit log.
- Public website covering the product overview, feature catalogue, security model, documentation entry point and changelog.
- Initial product, architecture, security and design baseline.
- Docker Compose distribution of the control plane: PostgreSQL, the control server, and Caddy serving the application and obtaining its certificate, with the REST API and the database reachable only from inside the stack.
- An installer that prepares a host in one command — checking it first, generating this deployment's secrets and certificate authority, applying the schema, waiting until the control plane is actually serving, and creating the first administrator — and that replaces nothing when it is run again.
- `dockplane-control` for everyday operation: status, start, stop, restart, logs, version, and a doctor that checks the whole deployment without printing any of it.
- Backup and restore of the control plane: the database, the application encryption key, the agent certificate authority and Caddy's certificates, with a manifest and checksums. A restore validates the whole backup before touching anything, saves the current deployment first, signs everyone out, invalidates unused enrollment tokens and cancels actions that were still running.
- Debian packages and tarballs of the agent for amd64 and arm64, with a systemd unit, and a release build that produces byte-identical artefacts from the same commit.
- Multi-architecture control plane images for amd64 and arm64, with software bills of materials and build provenance attached.
- `GET /api/v1/version` reporting the release, the commit, the build date, the agent protocol version and the database schema version.
- Releases are built and published from a tag: every gate runs first, the images are pushed with their bill of materials and provenance, and the bundle, both agent packages, both tarballs, the manifest, the vulnerability reports and one checksum file over all of them are attached to the release.

### Known limitations
- Backups are not encrypted. They contain the agent certificate authority's private key and the application encryption key, and must be kept on encrypted storage.
- Enrolling the same machine a second time creates a new host record; the previous one remains in the inventory, marked revoked, and every operation against it is refused.
- There is no automatic update mechanism and no APT repository. Upgrades are a documented sequence of commands.
- There is deliberately no shell, exec or arbitrary command execution on a managed host, and Compose projects are read-only.
