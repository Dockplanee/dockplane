# Interface Versions

Four numbers decide whether two pieces of Dockplane can work together. A change
to any of them is a deliberate act with a migration story, not something that
happens because a struct was edited.

| | Value | Changes when |
| --- | --- | --- |
| Protocol version | **1** | The agent gateway's message format changes in a way an older agent cannot read |
| Schema version | **0015_stack_operations** | A migration is added |
| Backup format version | **1** | The layout of a backup directory changes |
| Stack plan version | **2** deploy, **1** lifecycle | The shape of the plan the agent is sent changes |

## Where each one lives

| | Declared in | Reported by |
| --- | --- | --- |
| Protocol | `agent/internal/protocol/protocol.go`, `api/src/agents/protocol.ts` | `GET /api/v1/version`, `dockplane-agent version` |
| Schema | the last entry of `api/src/database/migrations/meta/_journal.json` | `GET /api/v1/version`, as both `schemaVersion` and `appliedSchemaVersion` |
| Backup format | `deploy/backup-restore.sh` | every backup's `manifest.json` |
| Stack plan | `agent/internal/docker/stack.go`, `stack_lifecycle.go`, `api/src/stacks/stack-plan.ts` | every plan, in its `planVersion` field |

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

**Stack plan.** A deployment or a lifecycle operation reaches the agent as a
resolved plan with its shape declared in it. An agent that does not recognise
the version refuses the plan rather than acting on the parts it understands —
which, for an operation that creates and destroys containers, is the difference
between a refusal and a stack nobody can account for.

## During a release candidate

These values are fixed for `0.2.0-rc.1` and must be identical in the final
`0.2.0`. If one of them has to change before release, the change is a new
release candidate, not a quiet correction: an operator who installed the first
candidate has agents enrolled against it and backups taken from it.

## What 0.2 changed

The schema moved from `0005_host_setup` to `0015_stack_operations`, which is
what an upgrade applies. The protocol version and the backup format version are
unchanged, which is why a 0.1.0 agent goes on working against this control
server and a backup taken by either is readable by both. The stack plan is new
in this series and did not exist in 0.1.

## Seeing them

`GET /api/v1/version` reports the server's build, its protocol version and both
schema versions without a session, because a deployment has to be able to say
what it is before anyone can sign in.

Signed in, **Settings → System** shows the same values alongside the browser
application's own version and a summary of what the agents report. What that
panel does and does not do — including the update check, which is off unless an
administrator turns it on — is described in
[Versions](../operations/versions.md).

## Related

- [Versions](../operations/versions.md)
- [Agent Gateway](agent-gateway.md)
- [Backup and Recovery](../operations/backup-restore.md)
- [Building a Release](../operations/releases.md)
