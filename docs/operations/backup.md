# Backup and Recovery

A Dockplane control plane is three things, and a backup that has fewer than all
three is not a backup:

| | Losing it means |
| --- | --- |
| the database | who exists, what they may do, every host and everything that happened |
| the application encryption key | the MFA secrets in that database can never be read again |
| the agent certificate authority | every managed host has to be enrolled again, by hand |

The backup command takes all three, plus Caddy's certificates and the `.env`.

## What is not in it

- **Anything on a managed host.** Your containers, their volumes and their data
  are not Dockplane's to back up. Back them up as you did before Dockplane.
- **Live log streams.** They are connections, not state.
- **The agents' own identities.** Each agent keeps its private key on its own
  host and it never leaves. A restored control plane recognises those keys
  because the authority that issued them is in the backup.

## Taking a backup

```bash
sudo /opt/dockplane/dockplane-control backup /var/backups/dockplane-$(date -u +%Y%m%dT%H%M%SZ)
```

It runs against a live deployment. Nothing is stopped, no agent disconnects,
and operators stay signed in. Anything that changes after the dump begins
belongs to the next backup.

The result is a directory:

```text
dockplane-20260811T104000Z/
├── manifest.json    what this is: versions, schema, components
├── SHA256SUMS       over every file above and below
├── database.dump    pg_dump, PostgreSQL's own format
├── env              the deployment's settings
├── secrets/         database password, connection string, encryption key
├── pki/             agent authority and gateway certificate
└── caddy/           issued certificates and the ACME account
```

It is assembled under `.partial`, checksummed, verified, and only then given
its name. **A directory ending in `.partial` is not a backup** — an
interrupted run leaves one rather than something that looks usable.

### Keep it somewhere safe

> **The backup contains the agent certificate authority's private key and the
> application encryption key, both unencrypted.** Anyone who reads it can
> impersonate every managed host.

It is created mode 0700, owned by root, with keys at 0600. That protects it on
the machine it was written on and nowhere else. **Copy it to encrypted
storage.** Dockplane does not encrypt the archive itself and does not claim to:
a 0700 directory is not encryption.

There is no scheduled backup, no upload, and no retention policy. Take backups
on your own schedule with your own tooling, and delete old ones yourself —
nothing here removes a backup.

## Restoring

```bash
sudo /opt/dockplane/dockplane-control restore /var/backups/dockplane-20260811T104000Z
```

It reads and checks the whole backup before touching anything: the manifest,
the format version, every required component, the checksums, and whether this
version understands that schema. A backup that fails any of those is refused
and the running deployment is left exactly as it was.

Then it asks you to type `restore`. `--yes` means it for automation; without a
terminal and without that flag it refuses.

**The current deployment is backed up first**, into
`/opt/dockplane/pre-restore-<timestamp>`. If that fails, the restore stops.
Delete the snapshot yourself once you are satisfied.

### What a restore changes

| | |
| --- | --- |
| Sessions | **all revoked.** Everyone signs in again. A cookie from before an incident is a credential nobody decided to keep. |
| Enrollment tokens | **unused ones revoked.** A one-time token from before the backup must not become usable again weeks later. |
| Actions | anything **queued or running becomes cancelled**, and never runs. Otherwise the first agent to reconnect could be handed a `stop` from another week. |
| Agents | **untouched.** They reconnect on their own, within about two minutes, without enrolling again. |
| Agent certificates | untouched. They were issued by the authority in the backup, which is restored exactly as it was. |

### Which values travel, and which belong to the machine

| | |
| --- | --- |
| Portable — restored | the database contents, the application encryption key, the agent certificate authority and gateway certificate, Caddy's certificates |
| Local — kept as they are | the database password and connection string, and the rest of `.env` |

A dump carries tables, not roles, so the credentials that work after a restore
are the ones the PostgreSQL you restored into was created with. The backup
contains the old ones for reference and they are deliberately never applied:
if they were, `.env` would point at one password while the database expected
another, and nothing would start.

## Disaster recovery onto a new machine

1. Install the control plane on the new host as usual — see
   [Installation](../getting-started/installation.md). It creates its own
   secrets and its own authority; the restore replaces them.
2. Copy the backup to it.
3. `sudo /opt/dockplane/dockplane-control restore <backup>`
4. Point the DNS record at the new host.
5. Wait. Enrolled agents reconnect by themselves.

**Agents do not need to be touched.** They trust the agent authority, not the
browser certificate, and that authority came back with the backup. They keep
their own identity and reconnect to the same hostname.

If the control plane moves to a **different hostname**, agents will not follow:
each one stores the gateway address it was enrolled with. Keeping the same
hostname is what makes recovery invisible to them. If you must change it, every
host has to be enrolled again.

### Certificates after recovery

Caddy's certificates come back with the backup, so the new host serves HTTPS
without asking Let's Encrypt for anything — as long as the DNS record points at
it.

If they are missing, or the backup predates them being included, Caddy simply
requests new ones. That is normally fine, with one caveat worth knowing before
you need it: **Let's Encrypt limits how many certificates you may obtain for
the same name in a week.** Rebuilding a deployment repeatedly can exhaust that,
and then the site has no certificate until the limit resets. This is exactly
why the certificates are in the backup.

## How often

Before every upgrade, and on a schedule that matches how much you are willing
to redo by hand. The database changes constantly; the encryption key and the
certificate authority change almost never — but they are the parts that cannot
be recreated.

`dockplane-control doctor` reports whether everything a backup needs can be
read.

## Related

- [Installation](../getting-started/installation.md)
- [Troubleshooting](troubleshooting.md)
- [Recovery](recovery.md)
