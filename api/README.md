# Dockplane Control Server

The Dockplane API. It owns identity, authorization and the audit trail, and
stores durable control-plane state in PostgreSQL.

See `docs/getting-started/control-server.md` for setup, and
`docs/administration/` for the session, MFA and role models.

## Commands

```bash
npm install
npm run db:migrate          # schema and authorization catalog
npm run setup:agent-ca      # internal agent certificate authority
npm run bootstrap:admin     # create the first administrator
npm run build && npm start
npm run start:dev
```

`setup:agent-ca` is run once per deployment and refuses to overwrite existing
material. Replacing the CA would invalidate every enrolled agent.

## Checks

```bash
npm run build
npm run lint
npm run typecheck
npm test
npm run format:check
```

Tests run against a real PostgreSQL instance and a real TLS listener, because
the guarantees under test depend on real constraints, real transactions and a
real certificate exchange. Point `DATABASE_URL` at a disposable database:

```bash
DATABASE_URL=postgres://dockplane:dockplane@localhost:5433/dockplane npm test
```

The suites run serially. They share one database and reset it between tests, so
running them concurrently would have them truncate each other's fixtures.

Each suite boots the application on a loopback port of its own and keeps that
listener for its whole life. Both this and the agent gateway bind `127.0.0.1`
explicitly: a wildcard socket and a loopback socket may hold the same port
number at once on BSD, and a request to `127.0.0.1` then reaches whichever of
the two is more specific — which is how an HTTP request ends up reading a TLS
handshake. Binding both to the same address makes the operating system refuse a
collision instead of allowing one.

Set `TEST_LOG_LEVEL` to see the server's own account of a run:

```bash
TEST_LOG_LEVEL=warn npm test
```

## Structure

```text
src/config/       schema-validated configuration and injection tokens
src/logging/      structured logging, redaction, request correlation
src/database/     schema, migrations, seed, connection
src/common/       crypto primitives, error model, validation pipe
src/auth/         sessions, login, CSRF, throttling
src/mfa/          TOTP and recovery codes
src/rbac/         permission catalog, guard, authorization service
src/audit/        audit trail
src/users/        user and role administration
src/agents/       certificate authority, enrollment, registry, mTLS gateway
src/discovery/    capability dispatch, reconciliation, scheduling
src/inventory/    read-only views over discovered infrastructure
src/operations/   container lifecycle: authorization, dispatch, action records
src/logs/         live log streams: limits, lifecycle, server-sent events
src/events/       operational events, separate from the audit trail
src/health/       liveness and readiness
```

## Listeners

The process binds two ports. The API serves browsers over session cookies. The
agent gateway is a separate TLS listener that requires a client certificate
from the internal agent CA; identity is the fingerprint of that certificate and
nothing else.

The gateway does not honour a forwarded client-certificate header, so a reverse
proxy in front of it must pass TCP through rather than terminate TLS. See
`docs/architecture/agent-gateway.md`.

## Notes

The build uses the Nest compiler rather than `tsx`. Nest resolves dependencies
from decorator metadata, and esbuild — which `tsx` uses — cannot emit it. The
standalone scripts do not use Nest injection and run under `tsx` fine.
