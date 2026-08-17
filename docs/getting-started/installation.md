# Installation

Dockplane is two things to install: a control plane, and an agent on each
Docker host you want to manage.

**The control plane runs as a Docker Compose stack.** That is the supported way
to run it. **The agent does not run in a container**: it is a native binary
under systemd on each managed host, because it manages the Docker daemon it
runs beside.

```text
Browser
   │ 443/tcp
   ▼
Caddy ──────► the application (static)
   │ /api/*
   ▼
control server ──► PostgreSQL          (neither is published)
   │
   │ 9443/tcp, mutual TLS
   ▼
agents on managed hosts ── outbound only
```

Nothing needs to reach into a managed host. Agents connect outward.

## Quick start

Point a DNS record at this server first — `dockplane.example.com` to its
address — because a certificate is obtained on the first start.

Take the release and its `SHA256SUMS` from the
[releases page](https://github.com/Dockplanee/dockplane/releases):

```bash
VERSION=0.3.0        # the release you are installing

sha256sum -c SHA256SUMS                     # 1. check what you downloaded
tar xzf "dockplane-$VERSION.tar.gz"         # 2. unpack it
cd "dockplane-$VERSION"

sudo ./install-control-plane.sh --domain dockplane.example.com
```

Then open `https://dockplane.example.com`, sign in, and add a Docker host:
create an enrollment token under **Agents**, install
[the agent](../operations/agent.md) on that host, and enroll it.

There will be no `curl … | bash` one-liner. Downloading a script and running it
unread, from a URL that can answer differently next time, is not an
installation method this project will publish.

## Requirements

- A Linux host with Docker Engine and the Compose plugin
- A DNS name pointing at it, resolvable before the first start: Caddy asks
  Let's Encrypt for a certificate for it
- Ports 80, 443 and 9443 reachable from outside
- Roughly 1 GB of memory and 5 GB of disk for the control plane itself

The installer supports Ubuntu 24.04, Ubuntu 22.04 and Debian 12, and refuses
anything else rather than guessing. It is verified on Ubuntu 24.04 with Docker
Engine 29 and Compose v5.

It does not install Docker. There is more than one legitimate way to install
Docker Engine, and choosing one on your behalf — by piping a script from the
internet into a shell as root — is not a decision an installer should make.

## Layout

Everything the deployment owns lives in one directory:

```text
/opt/dockplane/
├── compose.yaml           from deploy/compose/
├── Caddyfile              from deploy/compose/
├── .env                   settings, no secrets            0600 root
├── secrets/               one file per secret             0400 uid 10001
│   ├── postgres-password
│   ├── database-url
│   └── application-encryption-key
└── pki/                   the agent certificate authority 0700 uid 10001
    ├── agent-ca.crt
    ├── agent-ca.key
    ├── gateway.crt
    └── gateway.key
```

Durable state that is not a file lives in Docker volumes: `postgres-data`,
`caddy-data` and `caddy-config`.

`10001` is the account the control server runs as, in the container and on the
host. It is deliberately not `1000`, which on most distributions is the first
human login account — the secrets and the certificate authority belong to the
service and to root, and to nobody else.

## Install

```bash
sudo ./install-control-plane.sh --domain dockplane.example.com
```

That is the installation. It checks the host before writing anything, prepares
the directory, generates this deployment's secrets and certificate authority,
starts the stack, waits until the control plane is actually serving, and offers
to create the first administrator.

On a clean Ubuntu 24.04 host with the images already present it takes about
twenty seconds.

The installer will not install Docker, will not change your firewall, and will
not stop another service to free a port. If something is in the way it says
what, and stops.

### What it asks

- **The domain.** The hostname browsers will use. Its DNS record must point at
  this server before the first start, because Caddy asks Let's Encrypt for a
  certificate for it. The installer checks the record and, if it does not point
  here yet, says so and lets you decide whether to continue.
- **The first administrator.** An email address and a password. The password is
  typed at a prompt that does not echo it; it is never an argument, never in
  the environment, and never in the installer's output.

For an unattended installation, every answer can come from a flag:

```bash
sudo ./install-control-plane.sh \
  --domain dockplane.example.com \
  --admin-email you@example.com \
  --admin-password-file /root/admin-password \
  --yes
```

The password file is read, copied to a file only the service account can read
for the length of one command, and removed. Delete your own copy afterwards.

### Running it again

Safe, and sometimes useful. A second run never replaces a secret, the
certificate authority, the database or your `.env`; it reports what is already
there, starts what is not running, applies any pending schema change and checks
the result. It is how you finish an installation that stopped halfway.

An installation that fails never records itself as complete. The marker that
says a deployment is installed is written only once it is serving.

### What it creates

```text
/opt/dockplane/
├── compose.yaml          the stack
├── Caddyfile             the proxy
├── .env                  settings                        0600 root
├── version               what is installed here
├── dockplane-control     status, logs, doctor
├── secrets/                                              0700 uid 10001
│   ├── postgres-password                                 0400
│   ├── database-url                                      0400
│   └── application-encryption-key                        0400
└── pki/                                                  0700 uid 10001
    ├── agent-ca.crt  agent-ca.key                        0644 / 0600
    └── gateway.crt   gateway.key
```

`10001` is the account the containers run as, on the host and inside them.
Deliberately not `1000`, which on most distributions is the first human login
account.

### Afterwards

```bash
/opt/dockplane/dockplane-control status     # what is running
/opt/dockplane/dockplane-control logs       # follow them
/opt/dockplane/dockplane-control doctor     # check the whole deployment
/opt/dockplane/dockplane-control stop       # stop it, keeping all data
```

`doctor` checks Docker, the Compose configuration, the files and their
permissions, the certificate authority, each container's health, HTTPS, the
agent gateway, and that neither the API nor the database is published. It
prints no secrets.

## Installing by hand

Everything the installer does can be done by hand, and the pieces it uses are
the same ones documented below: `deploy/compose/compose.yaml`, the `Caddyfile`,
and `setup-agent-ca.js` for the authority. The sections that follow describe
that arrangement; use them if you want to place things differently, and the
installer otherwise.

## Ports

| Port | Direction | Who | Published by |
| --- | --- | --- | --- |
| 80/tcp | inbound | certificate issuance, redirect to 443 | Caddy |
| 443/tcp+udp | inbound | browsers | Caddy |
| 9443/tcp | inbound | enrolled agents, mutual TLS | the control server |

The REST API (3000) and PostgreSQL (5432) are **not** published. The API is
reachable only from Caddy, over an internal network; the database only from the
control server and the migration job, over a network with no route out at all.

`sudo ss -tlnp` on the host will confirm it.

**The agent gateway is not proxied and must not be.** It authenticates each
host by the client certificate that host presents. A proxy terminating that TLS
would replace every agent's identity with its own, and no header can carry the
difference back.

## Upgrading

An upgrade is the new release's installer, run on the machine that already has
Dockplane:

```bash
VERSION=0.3.0                               # the release you are moving to

sha256sum -c SHA256SUMS                     # 1. check what you downloaded
tar xzf "dockplane-$VERSION.tar.gz"         # 2. unpack it
cd "dockplane-$VERSION"

sudo ./install-control-plane.sh --domain dockplane.example.com   # 3. upgrade

curl -fsS https://dockplane.example.com/api/v1/version           # 4. check
```

It recognises what is already installed and says what it is about to do:

```text
==> Dockplane upgrade
    0.2.0 -> 0.3.0
```

Then, in this order: a backup of the current deployment, this release's Compose
file and Caddyfile staged and rendered before they are adopted, the images from
the bundle, the schema migration, and only then the containers. The version on
disk is updated last, once the result is serving.

**Do not upgrade by pulling images and editing `.env`.** A release can change
more than an image tag — a new setting has to reach the container that reads it,
and that lives in the Compose file the installer replaces. An upgrade that skips
it leaves the new version running against the old deployment description, which
fails in ways that look unrelated.

Running the migration before replacing anything means that if it fails, nothing
has been replaced: the previous version keeps serving while you investigate. The
control server refuses to start against a schema older than it expects, so a
forgotten migration is a service that does not come up rather than one that half
works.

What is kept: the database, every secret, the certificate authority, Caddy's
certificates, the domain, and any setting you added to `.env`. A setting this
release introduces is appended with its default; nothing you set is overwritten.
The previous Compose file and Caddyfile are left beside the new ones as
`compose.yaml.pre-upgrade` and `Caddyfile.pre-upgrade`, and the backup path is
printed.

`/api/v1/version` reports what is running:

```json
{
  "version": "0.3.0",
  "protocolVersion": 1,
  "schemaVersion": "0005_something",
  "appliedSchemaVersion": "0005_something"
}
```

Those last two agreeing is the check. Agents are upgraded separately and older
agents keep working, as long as they speak the same `protocolVersion`.

### What an upgrade never requires

Deleting the database. If an upgrade seems to ask for that, it is a bug.

### Rolling back

**A code rollback after a forward migration is not automatically safe.** Once a
migration has run, the schema is the new one, and the previous version was
never written against it. `docker compose down && start the old version` is
therefore not a guarantee, and this project will not pretend otherwise.

For v0.1:

- migrations are backward compatible where possible, and destructive changes
  are avoided
- **take a backup before upgrading**:
  `sudo /opt/dockplane/dockplane-control backup /var/backups/before-upgrade`
- if a rollback is needed, restore that backup and start the old version

See [Backup and Recovery](../operations/backup-restore.md).

## Stopping and starting

```bash
sudo docker compose stop      # closes agent connections and log streams, keeps everything
sudo docker compose start
sudo docker compose down      # removes the containers; volumes and secrets survive
```

`down` does not remove the database, the certificate authority or Caddy's
certificates. Only `down -v` would remove the volumes, and that deletes the
database.

After a host reboot nothing needs to be run: the containers come back on their
restart policy, the agents reconnect, and signed-in operators keep their
sessions, which live in PostgreSQL rather than in memory.

## Running the control server natively instead

The control server can also run directly under systemd, with PostgreSQL and a
reverse proxy installed on the host. That arrangement works and is described in
[Running the Control Server](../development/running-locally.md), but **Compose is the supported
distribution for v0.1** and is what upgrades are tested against. Choose the
native route only if you have a specific reason to.

## Backing it up

Three things cannot be recreated: the database, the application encryption key
and the agent certificate authority. All three are in one command:

```bash
sudo /opt/dockplane/dockplane-control backup /var/backups/dockplane-$(date -u +%Y%m%dT%H%M%SZ)
```

Take one before every upgrade, and keep it on encrypted storage — it contains
this deployment's private keys. See [Backup and Recovery](../operations/backup-restore.md).

## Related

- [Backup and Recovery](../operations/backup-restore.md)
- [Install the Agent](../operations/agent.md)
- [Connect the First Docker Host](add-host.md)
- [Running the Control Server](../development/running-locally.md) — the native alternative
- [Troubleshooting](../operations/troubleshooting.md)
