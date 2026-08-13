# Stacks

A stack is a Compose file, the environment it needs, and the host it belongs to.
Dockplane keeps the whole history of what a stack has been configured to be.

A stack can be saved, deployed, moved to another revision and put back to an
earlier one; started, stopped and restarted as a whole; and deleted. All of it
from the interface or the API.

## Creating a stack

**Stacks → Create stack.** A stack needs a name, a host, and a Compose file.

The name is also the Compose project name on the host, so Compose's own rule
applies: lower-case letters, digits, hyphens and underscores.

The host can be one whose agent is offline. Writing a stack down is not a change
to a machine, so it is saved either way — it simply cannot be deployed until the
agent is connected.

Values the Compose file refers to are defined beside it, as environment
variables. Mark one secret and Dockplane stores it encrypted and never shows it
again.

**Validate** sends the file to Dockplane's Compose compiler — the same one that
has to accept it before it can be saved — and reports what it would create, or
what is wrong with it and where. Editing the file afterwards makes that answer
stale, and it says so.

Creating a stack does not deploy it. The stack is saved as revision 1 and
reports that it is not deployed.

## Saving and deploying are separate

Saving a change writes a new revision. It does not touch the host.

A stack therefore reports two things that are not the same: the newest revision
anybody saved, and the revision Dockplane has confirmed is running. When they
differ, the stack says `Changes not deployed` — which is an ordinary state, not
a fault — and offers to deploy the newer one.

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

### From the interface

The stack's page offers whichever of these applies. The revision history offers
each revision by number: a newer one is deployed, an older one is rolled back
to, and while a stack needs attention any revision can be used to repair it.

Before anything is applied, Dockplane shows what changes between the running
revision and the target — the Compose file line by line, and the environment
variable by variable. Two secrets of the same name are reported as being secret
in both revisions rather than compared: the interface is never shown a stored
secret and does not pretend to know whether one changed.

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
connection, a restarted control server — Dockplane says so rather than guessing,
and the stack reports that it is reconciling. That is not a failure: the host
may have applied the revision.

The attempt stays open, nothing is sent again and no further deployment is
accepted. It is settled from the host itself the next time that host is read
completely, and the stack becomes deployed, unchanged or in need of attention
according to what is actually there.

### Containers of a stack

A container that belongs to a stack is configured by that stack. It cannot be
edited or removed on its own, and while a deployment or an operation of its
stack is unresolved it cannot be started, stopped or restarted either.

## Starting, stopping and restarting

A deployed stack can be stopped and started again. None of these deploys
anything: no revision is applied, no container is created or recreated, and the
revision the stack is deployed with is the same afterwards.

**Stop** stops every running service, in reverse dependency order — whatever
depends on something goes down before the thing it depends on, so a database is
not taken away from a service still writing to it.

**Start** starts every service in dependency order. A service that is already
running is left alone.

**Restart** stops the stack and starts it again, in those same two orders. It is
deliberately not a Docker restart of each container: those would overlap, and a
service would spend the window talking to something on its way down. Nothing is
recreated, so every container keeps its identifier, its image, its configuration
and its volumes.

### A stopped stack is still deployed

The interface reports the deployed revision and the runtime state separately,
because they answer different questions. A stopped stack still has a deployed
revision; starting it again runs that revision.

**Stopping and starting never deploy saved changes.** A stack deployed with
revision 4 while revision 5 is the newest thing saved is stopped as revision 4
and started as revision 4. Deploying revision 5 is a separate, deliberate act.

### No Compose file is read

A lifecycle operation compiles nothing and decrypts nothing. It works from the
containers that are already there and the identities Dockplane gave them.

That is deliberate: a stack whose Compose source no longer compiles — because a
variable it needs was removed, or because the compiler or the encryption key is
unavailable — is still one an operator can stop. The path needed during an
incident is the one with the fewest things in it.

### What is refused

A stack that has never been deployed cannot be started: there are no containers
to start, and creating them is deploying a revision.

A stack that needs attention cannot be started, stopped or restarted. Whoever
resolves it does so by applying a revision, and that decision is made from what
is on the host; changing what is there first changes the evidence.

A stack with an unresolved deployment or operation accepts neither. Only one
thing may be deciding what a stack is.

Nothing is created to make an operation possible. If a service the stack should
have has no container on the host, if two containers claim to be the same
service, or if a container carries an identity Dockplane did not give it, the
operation stops before anything moves.

### When only part of the stack moves

If some services move and others do not, nothing is undone. The stack says it
needs attention, and neither its containers nor the stack itself accept further
operations until somebody applies a revision to it — which recreates every
service and therefore converges the whole stack on one state.

Starting the stopped ones again to tidy up would be a mutation nobody asked for,
on a host that has just demonstrated it does not do what it is told.

### When the answer does not come back

As with a deployment: Dockplane says so rather than guessing, sends nothing
again, and settles the operation from the host the next time it is read
completely.

A restart is the one case a final state cannot answer on its own. The stack was
running before and is running after, with the same containers and the same
configuration — nothing an observer could compare has changed except when Docker
last started each container. Dockplane records that immediately before it
dispatches a restart, and afterwards a restart counts as having happened only
where every service is the same container, running, and started later than it
had been. A restart that cannot be demonstrated is recorded as one that did not
happen.

## Deleting a stack

Deleting a stack removes its service containers from the host and removes its
saved configuration — every revision, every environment variable and the
encrypted Compose source — from Dockplane.

The order is containers first, configuration second. The configuration is what
identifies the containers, so it is the last thing to go and it goes only after
the host has been read and shows nothing claiming to be the stack.

### Named volumes are kept

**Deleting a stack is not deleting your data.** Every named volume the stack
used stays on the host with its contents, and the confirmation lists them by
name so it is clear what remains.

There is no option to remove them. Not a checkbox, not a request field, not a
flag — `docker compose down -v` is deliberately not an operation this product
has. Removing a volume is a separate, explicit act against that volume.

### Networks are kept

Dockplane does not remove the networks a stack created. A network left behind by
a deleted stack is an ordinary Docker network that nothing is using; removing it
is a manual step for now.

### A new stack of the same name is a new stack

Creating a stack with the name of one that was deleted produces a **different**
Dockplane identity. The volumes and networks left behind carry the old
identity, so the new stack does not adopt them: deploying it stops with an
ownership conflict rather than mounting data that belonged to something else.

That is the intended answer. Reusing the data means deciding, deliberately, to
attach that volume to the new stack.

### What cannot be deleted

A stack that needs attention. Its host does not say clearly which containers are
the stack's, and that is exactly when a destructive operation must not proceed.
Apply a revision to it first. There is no force delete.

A stack with an unresolved deployment or operation, for the same reason
everything else is refused then: only one thing may be deciding what a stack is.

A stack whose deployed service has no container on the host. Dockplane cannot
say what removing it would remove, so it refuses rather than guessing.

### Nothing is read that does not have to be

Deleting a stack decrypts nothing — not the Compose source, not the environment,
not a single secret — and runs no compiler. A stack whose configuration can no
longer be compiled is still one an operator can remove.

### When only part of it is removed

If some containers are gone and others are not, nothing is rebuilt and nothing
is deleted from Dockplane. The stack needs attention, and its configuration
stays, because that is what somebody resolving it will work from.

### When the answer does not come back

Dockplane says so rather than reporting the stack deleted, sends nothing again,
and settles the deletion from the host the next time it is read completely. If
the containers are gone, the configuration is then removed; if they are all
still there, the deletion is recorded as one that did not happen.

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
