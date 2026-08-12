# Add a Host

A Docker host joins Dockplane by enrolling an agent. One command does all of
it: it works out what the machine is, downloads the agent package matching this
control plane, checks it against the checksums published with that release,
installs it, enrolls the host and starts the service.

Docker Engine has to be there already. Nothing else is installed.

## In Dockplane

**Hosts → Add host.**

Give the host a display name if you want one — it is optional, and a host that
arrives without one is named by its hostname. Dockplane produces a command:

```bash
printf '{"ticket":"%s"}' '<ticket>' | curl -fsS --proto '=https' --tlsv1.2 \
  --data-binary @- -H 'content-type: application/json' \
  https://dockplane.example.com/api/v1/host-setups/bootstrap | sudo bash
```

**No host record is created yet.** What exists is a *host setup*: your intent,
and a one-time ticket. The host and the agent are created by enrollment.

The command expires in ten minutes. You can regenerate it, which kills the
previous one, or cancel the setup entirely.

## On the machine

Run it as a user who can `sudo`.

```text
dockplane: downloading dockplane-agent <version> for amd64
dockplane: checksum verified
dockplane: installing the agent
dockplane: enrolling this host
Enrolled as 0f1c…
  gateway:     https://dockplane.example.com:9443
  certificate: valid until …
  state:       /var/lib/dockplane-agent

The private key stays on this host and is never transmitted.
dockplane: starting the service
dockplane: done. This host will appear in Dockplane within a few seconds.
```

The waiting view in Dockplane advances on what the control plane has actually
observed — the command was run, a certificate was issued, the agent connected,
the inventory arrived. Nothing on it moves on a timer.

## What the command does, in order

1. **Checks the machine.** Linux, amd64 or arm64, Debian 12 or Ubuntu 22.04 /
   24.04, systemd, and a reachable Docker Engine. It refuses rather than
   installing something that will not work.
2. **Refuses to overwrite an identity.** If the host is already enrolled it
   stops. See [Re-enrolling a host](#re-enrolling-a-host).
3. **Downloads the package** for this control plane's version from the release
   source, into a temporary directory it removes afterwards.
4. **Verifies the checksum** against `SHA256SUMS` published with that release,
   before installing anything.
5. **Installs the `.deb`**, which creates the service account and the unit, and
   starts nothing.
6. **Enrolls**, handing the enrollment token to the agent on standard input.
   The agent generates its key pair locally and stores the certificate it
   receives.
7. **Starts and enables the service.**

## The two credentials

The command carries one credential, and enrollment uses another. They have
different jobs.

**The bootstrap ticket** is the value in the command you can see. 256 bits of
random material, stored by the server only as a digest, spent by a conditional
update so two machines racing with the same command cannot both be served, and
dead after ten minutes, a cancellation or a regeneration.

It travels **in the request body**, not in the URL. A ticket in a query string
is written to every proxy log and access log between the machine and the
control plane; in the body it is not.

> **The ticket can survive in your shell history.** It has to reach the machine
> somehow. Until it is used, treat it as a password.

**The enrollment token** is what the agent actually enrolls with. It is
one-time, short-lived, stored only as a digest, and it never appears in the
visible command, in an argument list, in the process table or on disk. The
bootstrap response hands it to the agent on standard input.

There is deliberately no `--token` flag on the agent: an argument is visible in
the process list to every user on the machine.

See [Agent Security](../security/agent-security.md).

## Re-enrolling a host

The command stops on a machine that already has an agent identity:

```text
this host is already enrolled with Dockplane. Remove it there first, then
purge the agent with 'apt purge dockplane-agent'.
```

This is deliberate. An identity is not something to replace behind somebody's
back, and a second agent for one machine is not a state worth producing.

To move a host to a new identity:

1. **Revoke the agent in Dockplane** (Agents → the agent → Revoke). The
   certificate stays valid until you do.
2. **Purge the package on the host**, which deletes the identity, the private
   key and the configuration:

   ```bash
   sudo apt purge dockplane-agent
   ```

3. **Add the host again** from Dockplane.

> **A re-enrolled machine gets a new host identity in Dockplane.** The old host
> record stays behind and stops being refreshed. Dockplane does not merge the
> two, and this release has no way to reattach a new agent to an existing host
> record. See [Known Limitations](../reference/known-limitations.md).

## If it does not work

The command reports what failed and changes nothing after it. Common cases:

| | |
| --- | --- |
| `this bootstrap command has expired` | It lasts ten minutes. Generate a new one. |
| `could not download …` | The machine cannot reach the release source. See [Troubleshooting](../operations/troubleshooting.md). |
| `checksum does not match` | Stop. Do not install it. |
| `Docker Engine is not installed` | Dockplane manages Docker; it does not install it. |
| `unsupported distribution` | Install the agent by hand: [The Agent](../operations/agent.md). |
| Host never appears | The agent could not reach the gateway on 9443. See [Troubleshooting](../operations/troubleshooting.md). |

## Doing it by hand

Where the one-command flow does not apply — an unsupported distribution, an
air-gapped host, a configuration-managed fleet — install the package and enroll
manually. See [The Agent](../operations/agent.md).

## Related

- [The Agent](../operations/agent.md)
- [Agent Security](../security/agent-security.md)
- [Troubleshooting](../operations/troubleshooting.md)
- [Known Limitations](../reference/known-limitations.md)
