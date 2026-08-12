# Running the Control Server

The control server is the Dockplane API. It owns identity, authorization and the
audit trail, and it stores durable state in PostgreSQL.

It binds two listeners: the API for browsers, and the agent gateway for
enrolled hosts.

## Requirements

- Node.js 22 or newer
- PostgreSQL 16 or newer

## PostgreSQL

Create a database and a role for Dockplane:

```sql
create role dockplane with login password 'choose-a-strong-password';
create database dockplane owner dockplane;
```

For local development a container is enough:

```bash
docker run -d --name dockplane-postgres \
  -e POSTGRES_USER=dockplane \
  -e POSTGRES_PASSWORD=dockplane \
  -e POSTGRES_DB=dockplane \
  -p 5433:5432 \
  postgres:17-alpine
```

## Configuration

Copy `api/.env.example` to `api/.env` and fill it in. Every value is validated
at startup, and the server refuses to start if a required value is missing or a
production setting is unsafe.

Two values need generating:

```bash
# 32 bytes, base64. Protects MFA secrets at rest.
openssl rand -base64 32
```

`APPLICATION_ENCRYPTION_KEY` is deliberately not derived from the database. A
copy of the database alone therefore cannot decrypt MFA secrets. Back it up
separately from the database, and note that losing it means every enrolled
second factor has to be set up again.

`TRUSTED_PROXY_HOPS` must match the number of reverse proxies in front of the
API. A value that is too high lets a client spoof its source address and defeat
the per-address abuse controls.

`DEV_ALLOW_INSECURE_COOKIES` exists only so the interface works over plain HTTP
during development. Startup fails if it is enabled while `NODE_ENV=production`.

## Agent certificate authority

Agents authenticate with client certificates from an internal CA. Create it
once, before the first start:

```bash
cd api
npm run setup:agent-ca -- ./pki dockplane.example.com
```

Pass the hostnames agents will use to reach the gateway; they go into the
gateway server certificate. The command prints the paths to set for
`AGENT_CA_CERT_PATH`, `AGENT_CA_KEY_PATH`, `AGENT_CLIENT_CA_CERT_PATH`,
`AGENT_GATEWAY_TLS_CERT_PATH` and `AGENT_GATEWAY_TLS_KEY_PATH`.

It refuses to overwrite existing material. Replacing the CA would invalidate
every enrolled agent at once.

Back up the CA directory and restrict it to the account the server runs as.
Whoever holds the CA key can mint an identity for any agent. The key may be
encrypted with `AGENT_CA_KEY_PASSPHRASE`; startup warns if the key file is
readable by group or other.

## Migrations

The schema is applied only by explicit migration. Nothing synchronises tables at
runtime, so a forgotten migration fails visibly instead of rewriting a
production schema.

```bash
cd api
npm install
npm run db:migrate
```

The command also seeds the permission catalog and the built-in roles. It creates
no users.

## Initial administrator

Dockplane ships with no account and no default password. The first
administrator is created by an explicit command:

```bash
cd api
DOCKPLANE_BOOTSTRAP_PASSWORD='a strong passphrase' \
  npm run bootstrap:admin -- admin@example.com "Ada Lovelace"
```

Run it without `DOCKPLANE_BOOTSTRAP_PASSWORD` from a terminal to be prompted
instead. The password is never accepted as a command-line argument, where it
would appear in the shell history and in the process list.

The command refuses to run once an active administrator exists, and concurrent
attempts are serialised so exactly one account can be created.

## Starting the server

```bash
cd api
npm run build
npm start
```

For development with reload:

```bash
npm run start:dev
```

The API listens on `HOST`:`PORT` (`0.0.0.0:3000` by default). Behind a reverse
proxy on the same machine, set `HOST=127.0.0.1` so nothing but the proxy can
reach it.

The agent gateway listens separately on `AGENT_GATEWAY_PORT` (9443 by default)
and requires a client certificate; see
[Agent Gateway](../reference/agent-gateway.md) for the reverse-proxy
requirements.

`AGENT_GATEWAY_ADVERTISED_URL` is the address enrolling agents are told to
connect to. It must be reachable by the hosts and must use `https` in
production.

## Running it as a service

```bash
sudo install -m 0644 api/packaging/dockplane-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dockplane-server
```

The unit runs as the `dockplane` account, reads its configuration from
`/etc/dockplane/server.env` — so no secret appears in the process list — and is
sandboxed: no new privileges, an empty capability bounding set, a read-only
system, a system-call filter, and `UMask=0077` on anything it writes.

It is ordered after PostgreSQL but does not require it. Stopping the database
for maintenance therefore leaves the control server running and unready rather
than stopping it and leaving it stopped.

On `SIGTERM` the server closes its listeners, ends agent connections and open
log streams and exits. Restarting it does not disturb signed-in operators:
sessions are in PostgreSQL, not in memory. Agents reconnect on their own, with
a backoff that reaches a two-minute ceiling — a host may take up to that long
to reappear after a long control-server outage.

## Health

```text
GET /health/live    the process is running
GET /health/ready   the server can serve requests, which requires PostgreSQL
```

`ready` answers 503 with `{"status":"unavailable","checks":{"database":"unavailable"}}`
while the database is unreachable, and returns to 200 by itself once it is
back. `live` stays 200 throughout: the process is healthy, it simply cannot
serve. Neither endpoint returns configuration, and both sit outside the
versioned API so a probe does not break when the API takes a new version.

## Related

- [Installation](../getting-started/installation.md)
- [Connect the First Docker Host](../getting-started/add-host.md)
- [Troubleshooting](../operations/troubleshooting.md)
