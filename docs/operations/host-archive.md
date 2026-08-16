# Archiving Hosts

A machine that has been replaced, or an enrolment that has been superseded,
stops being somewhere you work and stays somewhere you look things up.
Archiving is how Dockplane records that.

## What archiving means

An archived host leaves the active host list and stops being offered as a place
to run new work. That is the whole of it.

It remains:

- a host in the database, with the same identifier it always had
- readable on its own page, with its last known inventory and metrics
- the host named by every container, Compose project and stack it ever carried
- the host named by every action and audit entry that mentions it

Its agent is untouched: not deleted, not revoked, and its certificate is
unchanged. Archiving is a lifecycle decision, not a security one. To withdraw an
agent's credential, revoke the agent — see [The Agent](agent.md).

## What archiving does not mean

It is **not a delete**. Nothing is removed, and there is no host delete in this
release.

It is **not a merge**. Dockplane does not decide that two host records are the
same machine, and archiving one makes no claim about the other. Six enrolments
of one server are six hosts before archiving and six hosts after it — which is
also why archiving is a manual decision rather than something inferred from a
system hostname, a Docker identifier or a quiet agent.

It is **not offline**. A host that is offline is still part of the working set:
you can still write a stack configuration for a machine that happens to be
powered down, exactly as in 0.2. An archived host is not a target for new work
whether it is answering or not.

## Archiving a host

On **Hosts**, open the row menu and choose *Archive host*. It is available to
anyone with the `hosts.archive` permission.

A host whose agent is connected **cannot** be archived. Archiving is for
identities that are finished, and taking a working machine out of the lists that
manage it is not what it is for. The control server checks this at the moment
the request arrives rather than trusting what the page was showing — an agent
can reconnect while you are reading — and refuses with `HOST_CONNECTED` if it
does.

Both archiving and restoring are recorded in the audit trail, against the host's
identifier rather than its hostname: a hostname is shared by every enrolment of
a machine and would not say which one was archived.

## Finding and restoring archived hosts

The hosts list shows the active hosts by default. The filter beside the search
box offers **Archived** and **All**.

*Restore host* puts it back. Restoring changes visibility and nothing else: no
reconnection is attempted, no agent is re-enrolled, and nothing on the machine
is started.

## What is refused while a host is archived

New operational work against the host:

- creating or changing a container on it
- starting, stopping or restarting its containers
- creating a stack for it, or saving a new revision
- deploying, starting, stopping, restarting or removing its stacks

All of these answer `HOST_ARCHIVED`. Restore the host if it is in use again.

Reading is never refused. Its containers, projects, stacks, logs already
collected, history and audit entries stay exactly as readable as before.

## If an archived host reports again

It stays archived, and Dockplane shows it as archived and connected — which is
unusual and is the truth. A heartbeat is not a decision; the archive state was
one, and only an operator undoes it.

The agent goes on using the identity it has, as long as it has not been revoked.

## Re-enrolment still creates a new host

Enrolling a machine again produces a new host identity, as it did before. That
is a real limitation and is recorded in
[Known Limitations](../reference/known-limitations.md).

Archiving does not change it. What archiving offers is a way to say which
identity is the current one, by taking the superseded ones out of the working
set — without pretending the records were ever the same thing.

## Related

- [The Agent](agent.md)
- [Known Limitations](../reference/known-limitations.md)
- [Audit](../security/security-model.md)
