# Interface Versions

Three numbers decide whether two pieces of Dockplane can work together. They
are frozen for the 0.1 series: a change to any of them is a deliberate act with
a migration story, not something that happens because a struct was edited.

| | Value | Changes when |
| --- | --- | --- |
| Protocol version | **1** | The agent gateway's message format changes in a way an older agent cannot read |
| Schema version | **0013_stack_deployments** | A migration is added |
| Backup format version | **1** | The layout of a backup directory changes |

## Where each one lives

| | Declared in | Reported by |
| --- | --- | --- |
| Protocol | `agent/internal/protocol/protocol.go`, `api/src/agents/protocol.ts` | `GET /api/v1/version`, `dockplane-agent version` |
| Schema | the last entry of `api/src/database/migrations/meta/_journal.json` | `GET /api/v1/version`, as both `schemaVersion` and `appliedSchemaVersion` |
| Backup format | `deploy/backup-restore.sh` | every backup's `manifest.json` |

## What each one guarantees

**Protocol.** An agent and a control server that report the same protocol
version can talk. This is what makes it safe to upgrade the control plane
without touching the agents, and to upgrade one agent at a time. An agent
presenting a version the server does not support is refused at the handshake
rather than half-understood.

**Schema.** The control server refuses to start against a database older than
the migrations it ships, so a forgotten migration is a service that does not
come up rather than one that fails on the first request touching a missing
column. `/api/v1/version` reports the schema the build expects and the schema
the database is at; on a healthy deployment they are the same value.

**Backup format.** A restore reads the format version first and refuses
anything higher than it understands, naming the version that wrote it. A
backup taken by a newer Dockplane is restored with that newer Dockplane.

## During a release candidate

These three values are fixed for `0.1.0-rc.1` and must be identical in the
final `0.1.0`. If one of them has to change before release, the change is a
new release candidate, not a quiet correction: an operator who installed the
first candidate has agents enrolled against it and backups taken from it.

## Related

- [Agent Gateway](agent-gateway.md)
- [Backup and Recovery](../operations/backup-restore.md)
- [Building a Release](../operations/releases.md)
