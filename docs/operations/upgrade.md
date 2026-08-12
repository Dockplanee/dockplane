# Upgrading

**The installer is the upgrade.** Download the release, check it, unpack it,
run it. There is one supported path and this is it.

```bash
VERSION=0.1.0        # the release you are installing

sha256sum -c SHA256SUMS
tar xzf "dockplane-$VERSION.tar.gz"
cd "dockplane-$VERSION"
sudo ./install-control-plane.sh --domain dockplane.example.com
```

The current release and its checksums are on the
[releases page](https://github.com/Dockplanee/dockplane/releases).

## Why not pull the images

**Pulling images and editing `.env` does not upgrade Dockplane**, and it is not
a documented path.

A release is not only two image tags. It can change the Compose file, the
Caddyfile, which settings are passed into the container, and the database
schema — and a new setting has to reach the container that reads it. An
upgrade done by hand leaves a deployment running new images against old
configuration, which fails in ways that are hard to attribute.

The installer replaces the deployment files, passes the new settings through,
migrates the schema in the right order, and records the version last.

## What it does, in order

1. **Recognises what is installed** and compares it with the bundle. A bundle
   older than what is running is refused; the same version is treated as a
   repair.
2. **Takes a safety backup** and reads it back. Nothing else happens until that
   succeeds — see below.
3. **Stages the new `compose.yaml` and `Caddyfile`** beside the existing ones
   and renders them with `docker compose config`. Only once that succeeds do
   they replace the originals. The previous pair are kept as
   `compose.yaml.pre-upgrade` and `Caddyfile.pre-upgrade`.
4. **Keeps your `.env`.** Settings you added are not touched. Settings a new
   release introduces are appended. The version is the one value the installer
   owns.
5. **Migrates the schema** before any container changes, in its own run.
6. **Recreates the containers** on the new images.
7. **Writes the version marker** last, so a failed upgrade never leaves
   something claiming to be finished.

Secrets, the agent certificate authority, the database and Caddy's certificates
are kept throughout.

## The safety backup

**Before a version upgrade changes anything, Dockplane takes a backup and
validates it.** It is written to:

```text
/var/backups/dockplane/pre-upgrade-<previous version>-<timestamp>/
```

The backup is taken through the same command an operator uses, and then read
back the way a restore reads it: the manifest, the checksum file, the database
dump, the environment, the application encryption key and the agent authority
all have to be present, the checksums have to match, the format version has to
be one this release can restore, and the directory must not be readable by
others.

**If the backup or its validation fails, the upgrade stops and nothing has been
changed.** An upgrade that cannot be undone is not one the installer will
start.

The backups are not removed by anything. Keep or prune them yourself.

> **Backups are not encrypted by Dockplane.** They contain the agent
> certificate authority's private key and the application encryption key. Put
> them on encrypted storage and restrict access to them.

See [Backup and Restore](backup-restore.md).

## Repairing a deployment

Running the installer with the version already installed is a repair: the
deployment files are restored from the bundle, settings are checked, and the
services are brought back up. Nothing that cannot be regenerated is touched,
and no backup is taken, because no version boundary is being crossed.

This is the way to recover a deployment whose `compose.yaml` or `Caddyfile` was
edited into a state that no longer starts.

## Which agent version new hosts get

After an upgrade, **Add host installs the agent matching the control plane you
are now running**. Nothing carries the previous version forward.

The exception is an explicit pin. If `AGENT_RELEASE_VERSION` is set in
`/opt/dockplane/.env`, that version is what new hosts receive, and it stays set
across upgrades because it is your setting. The installer reports it on every
upgrade:

```text
! AGENT_RELEASE_VERSION is pinned to 0.1.0-rc.3, not 0.1.0
  Add host will keep installing the 0.1.0-rc.3 agent on new machines.
```

`dockplane-control doctor` reports it too. To stop pinning, remove the line and
restart:

```bash
sudo sed -i '/^AGENT_RELEASE_VERSION=/d' /opt/dockplane/.env
sudo /opt/dockplane/dockplane-control restart
```

Agents already installed are not affected by any of this; they are upgraded on
their own hosts. See [The Agent](agent.md).

## Agents and the control server

They are upgraded independently. An older agent keeps working against a newer
control server as long as both speak the same protocol version, which
`dockplane-agent version` and `/api/v1/version` both report. See
[Interface Versions](../reference/interface-versions.md).

## Afterwards

```bash
/opt/dockplane/dockplane-control version
/opt/dockplane/dockplane-control doctor
```

`version` reports what the deployment is and what the running server says it
is, including the commit and the schema version it applied. `doctor` checks the
deployment and says what is wrong.

## Downgrading

There is no downgrade path. The installer refuses a bundle older than what is
installed. To go back, restore the safety backup taken before the upgrade with
the installer of that older release — see
[Backup and Restore](backup-restore.md).

## Related

- [Installation](../getting-started/installation.md)
- [Backup and Restore](backup-restore.md)
- [Troubleshooting](troubleshooting.md)
- [Interface Versions](../reference/interface-versions.md)
