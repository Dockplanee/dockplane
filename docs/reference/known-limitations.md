# Known Limitations

What this release does not do. Some of these are decisions and will not change;
the rest are simply not built yet. No dates are promised for either.

## Decisions

**There is no remote shell, exec or attach.** The agent has a fixed catalog of
typed capabilities and no way to run a command. This is the point of the
product, not a gap in it. See
[Security Model](../security/security-model.md).

**Compose projects are read-only.** They are discovered and inspected. Bringing
a project up or down, editing a Compose file, or redeploying a stack is not
part of this release.

**Container removal, volume deletion and image management are not
implemented.** Dockplane does not expose a destructive operation because the
Docker API has one.

**Dockplane does not install Docker.** It manages Docker Engine and expects it
to be there.

## Not built yet

**Re-enrolling a machine creates a new host record.** The old one stays behind
and stops being refreshed. Dockplane does not merge them, and there is no way to
reattach a new agent to an existing host record. See
[Add a Host](../getting-started/add-host.md).

**There is no automatic update and no self-updater.** Upgrades are explicit:
download a release, check it, run the installer. See
[Upgrading](../operations/upgrade.md).

**There is no APT repository.** The agent is installed from the `.deb` published
with a release, not from a package source.

**There is no downgrade path.** The installer refuses a bundle older than what
is installed. Going back means restoring a backup with the installer of the
older release.

**An agent must reach the control plane at the hostname it was enrolled with.**
Changing the control plane's domain means re-enrolling the hosts.

**Notifications, alerting and scheduled automation are not in this release.**

## Things to know

**Backups are not encrypted by Dockplane.** A backup contains the agent
certificate authority's private key and the application encryption key. Keep
backups on encrypted storage and restrict access to them. See
[Backup and Restore](../operations/backup-restore.md).

**Images are not signed.** A bill of materials and build provenance are attached
to each image as attestations. That is evidence of how an image was built; it is
not a signature, and it is not the same guarantee.

**arm64 is experimental — built and inspected, not runtime-tested.** See
[Supported Platforms](supported-platforms.md).

**Container output is not stored.** Logs are read from the host when you ask for
them, and a live stream is a connection. Dockplane keeps no log history, and
what a container printed is never written to the audit log. What is recorded is
that somebody read it.

**Granting `containers.logs` grants whatever the workloads print.** Applications
print passwords, tokens and personal data. The permission is separate from
`containers.read` for that reason.

**Membership of the `docker` group is equivalent to root on the managed host.**
The agent needs it to reach the Engine API. It is unavoidable for managing
Docker, and it is why the agent has no way to run a command.

## Related

- [Security Model](../security/security-model.md)
- [Supported Platforms](supported-platforms.md)
- [Product Scope](../product/PRODUCT_SCOPE.md)
