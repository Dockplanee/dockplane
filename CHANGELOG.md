# Changelog

All notable user-facing changes should be documented here.

Use release-oriented language.

Do not include internal prompt history, development conversation notes or artificial task numbering.

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
