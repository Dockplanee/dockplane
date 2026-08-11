# Dockplane Agent

The agent runs on a managed Docker host and reports what is there. It also
carries out three operations on request — starting, stopping and restarting one
container — and streams a container's output. Nothing in this module can remove
a container, run a command in one, or open a shell: the Docker API that carries
input is absent from its client interface entirely.

See `docs/getting-started/agent-installation.md` for installation and
`docs/integrations/docker.md` for what is and is not transmitted.

## Commands

```bash
dockplane-agent enroll --server https://dockplane.example.com --token-stdin
dockplane-agent run
dockplane-agent status
dockplane-agent version
```

## Build

```bash
go build -ldflags "-X main.version=$(git describe --tags --always)" \
  -o dockplane-agent ./cmd/dockplane-agent
```

Linux is the target. The module builds and its tests run on macOS for
development, but packaging, paths and the service unit assume Linux.

## Checks

```bash
gofmt -l .
go vet ./...
go test ./...
```

The default suite needs no Docker daemon. The tests that use a real one are
behind a build tag, because they create, operate and remove a throwaway
container:

```bash
go test -tags docker_integration ./internal/docker/
```

Those tests prepare and tear down the environment with the Docker CLI, because
the product code cannot: its Engine client interface exposes no way to create or
remove a container.

They run against whatever the machine is really running, so ownership is proven
rather than assumed. Every container they create is named for the run and
carries two labels:

```text
com.dockplane.e2e=true
com.dockplane.e2e.run=<identifier generated per run>
```

Immediately before each start, stop or restart, the harness checks all four
conditions: this run created the container, the suite label is present, the run
identifier matches, and the container is still the one Docker created under that
name. Anything else aborts the test rather than being operated on.

The run also compares every container it does not own before and after. A
foreign container that changed state fails the run and is reported with its
state before and after. Nothing is put back: restoring it would hide the defect.

## Structure

```text
cmd/dockplane-agent/   CLI: enroll, run, status, version
internal/config/       non-sensitive settings, validated at startup
internal/identity/     credential storage, atomic writes, verification
internal/enrollment/   one-time token exchanged for a certificate
internal/gateway/      outbound mTLS session, heartbeat, renewal, backoff
internal/protocol/     wire format, shared with the control server
internal/capability/   the capability registry and its handlers
internal/replay/       bounded cache of handled request identifiers
internal/docker/       Engine API access and the sanitised projections
internal/compose/      grouping by canonical Compose labels
internal/host/         host inventory
internal/metrics/      point-in-time host metrics
packaging/             systemd unit
```

## Notes

The capability registry is the only way to reach an operation. A name that is
not registered cannot be invoked, whatever the server sends, and the registered
set is asserted by a test that fails if a mutating capability ever appears.

The private key is generated on the host, stored at mode 0600 and never
transmitted or logged. The enrollment token is used once and is deliberately not
persisted.
