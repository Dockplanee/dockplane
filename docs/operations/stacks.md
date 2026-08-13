# Stacks

A stack is a Compose file, the environment it needs, and the host it belongs to.
Dockplane keeps the whole history of what a stack has been configured to be.

**Stacks cannot be deployed yet.** This release stores them and checks them.
A saved stack reports `not deployed`, because nothing has been created on a host
and saying anything else would be inventing a state.

## Revisions

Every save creates a revision, numbered from one. A revision is written once and
never changed: editing a stack adds another one rather than rewriting what was
there. That is what makes it possible to look at what a stack was configured to
be at any point, and later to go back to it.

Saved and deployed are separate. The newest saved revision is not automatically
the running one, and once deployment exists a stack will report both.

If somebody else saves while you are editing, your save is refused rather than
replacing theirs. Reload the stack and apply your change again.

## Validation

A revision is checked by Dockplane's Compose compiler before it is stored, so a
saved stack is one Dockplane could deploy. A Compose file that asks for
something unsupported is not saved at all — a configuration that turns out to be
undeployable is a problem best found at the moment it is written rather than the
moment it is needed. See [Compose Support](../reference/compose-support.md) for
what is accepted.

## The Compose file

The Compose source is stored encrypted, with the same key that protects every
other secret Dockplane holds, and it is not returned by ordinary reads. Opening
it requires the permission to change a stack, not merely to see one.

It is stored exactly as it was written — comments, formatting and all. Editing a
stack returns the file its author wrote rather than a machine's version of it.

## Environment

Each revision carries its own environment. A variable can be marked secret, and
Dockplane then stores it encrypted and never returns the value: normal reads say
a variable is secret and carry nothing else — no value, no length.

Editing is safe. A secret nobody touches is carried across to the new revision
unchanged, and the browser never has to send back a value it was never shown.
There is no way to reveal a stored secret in this release.

### Secrets written directly into a Compose file

A value written literally into the YAML is part of the file:

```yaml
services:
  db:
    environment:
      POSTGRES_PASSWORD: hunter2   # visible to anyone who may edit this stack
```

The file is encrypted at rest, so it is protected in the database and in
backups. But somebody who may open the stack for editing sees what is in it —
that is what editing means, and Dockplane cannot hide part of a file it is
handing back to be edited.

Use a variable instead, and set the value as a Dockplane secret:

```yaml
services:
  db:
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
```

The same boundary applies on the host as for any container: a value deployed as
a container environment variable is readable by anyone with Docker access there.
