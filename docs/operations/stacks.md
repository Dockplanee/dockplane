# Stacks

A stack is a Compose file, the environment it needs, and the host it belongs to.
Dockplane keeps the whole history of what a stack has been configured to be.

A stack can be saved, and a stack that has never run can be deployed. Changing
what is already running — redeploying, rolling back, stopping or removing a
stack — is not part of this release.

## Revisions

Every save creates a revision, numbered from one. A revision is written once and
never changed: editing a stack adds another one rather than rewriting what was
there. That is what makes it possible to look at what a stack was configured to
be at any point, and later to go back to it.

Saved and deployed are separate. The newest saved revision is not automatically
the running one, and a stack reports both.

If somebody else saves while you are editing, your save is refused rather than
replacing theirs. Reload the stack and apply your change again.

## Deploying

Deploying puts a stack on its host for the first time. It needs the deploy
permission, an agent that is connected, and the newest revision — deploying an
older one would leave the stack running something nobody saved last.

What happens, in order:

1. The revision is compiled again, from the Compose file and environment that
   were stored. No plan is kept between saving and deploying: a plan carries
   resolved values, secrets included.
2. Dockplane allocates one container for each service, so a deployment that is
   interrupted can still be identified afterwards.
3. The host pulls every image before it creates anything. A deployment that
   cannot get an image leaves the host as it was.
4. Networks, then volumes, then containers. Services start in dependency order.
5. The host is read back, and only then is the stack recorded as deployed.

A stack is deployed when Dockplane has seen its containers running on the host —
never because an agent said so. Health is observed and reported afterwards: a
deployment does not wait for a health check, because a database that takes a
minute to warm up is not a failed deployment.

### Nothing is taken over

Dockplane deploys the containers, volumes and networks it creates, and it will
not adopt one it did not. If a container, volume or network on the host already
has a name the stack needs and does not carry the labels saying Dockplane made
it for this stack, the deployment stops and nothing is renamed or removed. A
volume of the right name that Dockplane did not create holds somebody's data.

For the same reason, a Compose file that declares an `external` network or
volume is not accepted.

### When part of it starts

A deployment that creates some containers and then fails is reported as needing
attention. Nothing is removed — a container that ran may already have written to
a volume — the stack is not recorded as deployed, and it accepts no further
deployment until somebody resolves it. The containers that started keep running.

A deployment that created nothing is an ordinary failure: the host is as it was,
and the stack can be deployed again once the cause is fixed.

### When the answer does not come back

If the request reaches the host and the answer does not return — a lost
connection, a restarted control server — Dockplane says so rather than guessing.
The attempt stays open, nothing is sent again, and the stack accepts no further
deployment. It is settled from the host itself the next time that host is read
completely, and the stack becomes deployed, failed or in need of attention
according to what is actually there.

### Containers of a stack

A container that belongs to a stack is configured by that stack. It cannot be
edited or removed on its own, and while a deployment of its stack is unresolved
it cannot be started, stopped or restarted either.

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
