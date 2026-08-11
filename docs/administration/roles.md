# Roles and Permissions

Authorization is enforced by the control server. What the interface shows is a
convenience; it is never the access boundary.

## How it is enforced

Each protected route declares the permissions it requires, and a single guard
evaluates that declaration. There is no role-name check scattered through
handlers and no administrator fallback.

Authorization fails closed. A route with a declared requirement is refused when
there is no authenticated user, when the permission set is empty, or when a
required permission is missing.

## Permission catalog

A permission exists only when the control server actually enforces something
with it:

```text
hosts.read          view Docker hosts and their reported state
containers.read     view discovered containers
containers.start    start a container
containers.stop     stop a container
containers.restart  restart a container
containers.logs     read and follow container output
compose.read        view discovered Compose projects
agents.read         view enrolled agents
agents.enroll       create agent enrollment tokens
agents.revoke       revoke an agent credential
audit.read          read the audit log
users.read          view users
users.manage        create, modify and deactivate users
roles.read          view roles and their permissions
roles.manage        create and modify roles
sessions.read       view sessions of other accounts
sessions.revoke     revoke sessions of other accounts
```

The three lifecycle keys are deliberately separate. A single
`containers.manage` would be easier to grant and impossible to grant carefully:
an operator who should be able to restart a stuck service would also be able to
stop one for good.

`containers.logs` is sensitive in a way the others are not. Dockplane cannot
know what an application prints, and applications print passwords, tokens and
personal data. Granting it grants whatever the workloads on a host happen to
write, so it is granted deliberately rather than bundled with being able to see
that a container exists.

## Built-in roles

```text
Administrator   the full catalog
Operator        hosts, containers, Compose, agents, the audit log, restart, logs
Read Only       hosts, containers and Compose
```

Operator carries `containers.restart` but neither `containers.stop` nor
`containers.start`. Restarting a stuck service is day-to-day work; taking one
down and leaving it down is a decision with a different weight. Whoever needs
both gets both, by a deliberate grant rather than by inheriting it.

Built-in roles are defined in code and reconciled by every migration run, so a
release that adds a permission does not need a hand-written data migration.

## Assigning a role

```text
GET  /api/v1/users             requires users.read
POST /api/v1/users/:id/roles   requires users.manage
GET  /api/v1/roles             requires roles.read
```

Role assignment is audited with the actor, the target account and the role.
