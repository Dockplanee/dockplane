# Changelog

All notable user-facing changes should be documented here.

Use release-oriented language.

Do not include internal prompt history, development conversation notes or artificial task numbering.

## Unreleased

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
