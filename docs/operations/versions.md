# Versions

What an installation is running, where to see it, and the one thing Dockplane
will ask the outside world if you let it.

## What is local

Everything on this page is read from the installation itself unless the section
says otherwise. A Dockplane with no route out of its network reports all of it.

**Settings → System** shows:

| | What it is |
| --- | --- |
| Dockplane Server | the control server's release and the commit it was built from |
| Web Interface | the browser application's own release and commit |
| Database Schema | the migration the database has applied, and whether the build expects a newer one |
| Agent Protocol | the protocol version the control server speaks, and the oldest it accepts |
| Agents | how many agents are enrolled and which versions they report |

The server and the browser application are two images, deployed together but
pinned separately. They are reported separately for that reason: an operator
who has upgraded one and not the other is running two revisions, and one number
called "the Dockplane version" would hide it. The web version is compiled into
the bundle the browser loaded, so it describes the assets actually being served
rather than the container serving them.

`GET /api/v1/version` continues to report the server's build, protocol and
schema without a session, which is what a deployment must be able to say before
anyone can sign in. `GET /api/v1/system/versions` is the signed-in view and adds
the agent summary, which requires `agents.read`.

## Mixed agent versions

Agents are upgraded per host, so a fleet part-way through a rollout reports more
than one version. Dockplane calls that **mixed versions** and treats it as
information rather than a fault: it is marked on the agents list and named on
the overview, in the tone used for things worth knowing rather than things that
are wrong.

An agent on an older release is supported for as long as its protocol version
is one the control server accepts. That range is published in
[Interface Versions](../reference/interface-versions.md) and is what makes it
safe to upgrade the control plane first and the agents afterwards. Only an agent
outside that range is an incompatibility, and it is the one agent state
Dockplane reports as an error: the control server cannot drive it until it is
upgraded.

An agent that has never reported a version, or reports one Dockplane cannot
read, is counted as unknown. It is not ordered against the others and never
produces an "out of date" claim, because nothing is known about where it sits.

## The optional update check

Dockplane can tell you when a newer release has been published. It is **off**,
and it stays off on a new installation and across every upgrade until an
administrator turns it on.

Opening the settings page, loading the dashboard, signing in and enrolling an
agent do not turn it on and do not cause a request.

To turn it on, set it in the deployment's environment and restart the control
server:

```bash
UPDATE_CHECK_ENABLED=true
```

There is no setting in the interface, and the upstream cannot be changed: the
address is fixed in the control server, so nothing an operator installs can
point the check somewhere else.

### What is sent

When the check is on, the control server makes one request:

```text
GET https://api.github.com/repos/Dockplanee/dockplane/releases/latest
```

That is the whole request. It has no query string and no body. It carries the
two headers such a request needs — `accept: application/vnd.github+json` and
`user-agent: Dockplane` — and the user agent is that constant string, with no
version in it.

It does not carry, and there is no code path that could add:

- an installation identifier
- your domain, or the address Dockplane is reached at
- host names, container names or stack names
- how many hosts, containers or agents you have
- which versions your agents report
- anything about your users

This is the only request Dockplane makes to anywhere outside your network. It is
the same request any reader of the project's public release page makes, and the
release listing learns nothing from it beyond the address it came from — which
is true of any HTTP request and is why the check is off until you decide
otherwise.

### What is read

Four fields of the response: the tag, its link, and whether it is a draft or a
prerelease. The rest is not parsed. A response larger than a release listing
plausibly is, one that redirects elsewhere, or one that takes longer than a few
seconds is abandoned.

### How often

At most a few times a day. The answer is cached in the control server and
shared, so twenty browsers opening the settings page produce one request rather
than twenty, and none at all until the cached answer is old. A failure is
remembered too, so an upstream that is down is not asked once per page load.

If a later check fails, the last answer goes on being shown and is marked as the
last successful one.

### When it cannot answer

Dockplane is unaffected. The check has its own endpoint precisely so that a slow
or unreachable upstream cannot delay what the installation says about itself,
and the panel reports that the listing could not be reached — which is not the
same as reporting that there is nothing newer.

## Nothing installs anything

The result is a sentence. Dockplane does not download images, run an installer,
upgrade agents or restart anything on the strength of it, and there is no
control anywhere in the interface that does.

Upgrading is the documented manual process in [Upgrading](upgrade.md).

## Related

- [Upgrading](upgrade.md)
- [The Agent](agent.md)
- [Interface Versions](../reference/interface-versions.md)
