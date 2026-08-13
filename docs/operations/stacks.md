# Stacks

A stack is a Compose file, the environment it needs, and the host it belongs to.
Dockplane keeps the whole history of what a stack has been configured to be.

A stack can be saved, deployed, moved to another revision and put back to an
earlier one. Starting, stopping and removing a stack as a whole are not part of
this release.

## Revisions

Every save creates a revision, numbered from one. A revision is written once and
never changed: editing a stack adds another one rather than rewriting what was
there. That is what makes it possible to look at what a stack was configured to
be at any point, and later to go back to it.

Saved and deployed are separate. The newest saved revision is not automatically
the running one, and a stack reports both.

If somebody else saves while you are editing, your save is refused rather than
replacing theirs. Reload the stack and apply your change again.

## Applying a revision

Deploying a stack for the first time, moving it to a newer revision, putting it
back to an older one and repairing one that was left half-applied are the same
operation: make this revision the thing that is running. It needs the deploy
permission and an agent that is connected.

Any revision the stack has can be applied, not only the newest — going back to
an earlier one is exactly what a rollback is. Applying the revision a stack is
already running is refused: there would be nothing to do.

What happens, in order:

1. The revision is compiled again, from the Compose file and environment that
   were stored. No plan is kept between saving and deploying: a plan carries
   resolved values, secrets included. A revision that no longer compiles is
   refused before the host is touched — including an old one being rolled back
   to.
2. Dockplane allocates one container resource for each service, so an attempt
   that is interrupted can still be identified afterwards.
3. The host pulls every image before it changes anything. An attempt that cannot
   get an image leaves the stack exactly as it was.
4. Everything the stack currently has is stopped, renamed aside and disconnected
   from its networks.
5. Networks, then volumes, then containers. Services start in dependency order.
6. The containers that were moved aside are removed, keeping their volumes.
7. The host is read back, and only then is the revision recorded as the one
   running.

A revision is running when Dockplane has seen its containers running on the
host — never because an agent said so. Health is observed and reported
afterwards: an attempt does not wait for a health check, because a database that
takes a minute to warm up is not a failed deployment.

### Every service is recreated

Applying a revision recreates every service of the stack, including services
whose configuration did not change. Two reasons, both about being able to answer
questions afterwards.

Each running container then carries the revision it belongs to, so "is this
stack running revision 7" is something Dockplane reads off the host rather than
infers. Two revisions can differ in nothing observable — a changed password
leaves no other trace — and inferring would be guessing.

And a revision that swaps something between services can be applied at all. If
one service takes over the port, the name or the network alias another had,
replacing them one at a time collides with the containers being replaced.

**A revision transition interrupts the stack briefly.** Dockplane does not offer
zero-downtime deployment, and does not pretend to: the stack is stopped, rebuilt
and started again.

### Service identity

A service keeps the same Dockplane container for as long as it exists under the
same name across revisions. Its Docker container changes every time — that is
what recreating means — but the thing an operator looks at, links to and reads
history from stays the same.

A service that a revision adds gets a new one. A service that a revision removes
has its container removed once the new revision is running, and its volumes are
kept. If a service of that name comes back in a later revision, it is a new
container as far as Dockplane is concerned: nothing connects it to the one that
was removed.

## Rolling back

A rollback is deploying an earlier revision. There is no separate mechanism and
no hidden snapshot: the revisions are the rollback points, which is what makes
them immutable.

The newest saved revision does not change when an older one is deployed. A stack
can therefore be running revision 5 while revision 8 is the newest thing saved,
and it reports both.

**A rollback does not roll back data.** Volumes are not touched, so a database
that was migrated by the newer revision is still migrated after going back to
the older one. What returns is the configuration, not the state.

### Nothing is taken over

Dockplane deploys the containers, volumes and networks it creates, and it will
not adopt one it did not. If a container, volume or network on the host already
has a name the stack needs and does not carry the labels saying Dockplane made
it for this stack, the deployment stops and nothing is renamed or removed. A
volume of the right name that Dockplane did not create holds somebody's data.

For the same reason, a Compose file that declares an `external` network or
volume is not accepted.

### Volumes

Named volumes are never removed by Dockplane — not when a deployment fails, not
when a revision stops using one, and not when a service is removed. A volume
that a revision no longer mentions stays on the host with its data in it.

A volume the stack was already using and that is no longer on the host stops the
operation. Docker would happily create an empty one of the same name and the
stack would come up looking healthy, with the data gone and nothing saying so.

### When a revision does not come up

If a service of the new revision cannot be started, Dockplane puts the host back
as it found it: the containers it built are removed, and the ones it moved aside
are reconnected, renamed and started exactly as they were. The stack goes on
running the revision it was running, and the attempt is recorded as failed.

If putting it back does not fully work, Dockplane says so rather than reporting
a successful rollback. The stack then needs attention.

### When a stack needs attention

A stack needs attention when its host is neither the revision it was running nor
the one it was going to. Nothing is removed and nothing is guessed: the
containers that are up may already have written to a volume.

While a stack needs attention its containers cannot be started, stopped or
restarted individually — that would change the state the next decision is made
from. The way out is to apply a revision to it deliberately, choosing either the
one it was running or the one it was going to; Dockplane converges the host on
what was chosen.

The one case Dockplane will not resolve is two containers claiming to be the
same service of the stack. Choosing between them means choosing which of them to
destroy, so it refuses and leaves it to a person.

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
