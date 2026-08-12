# Supported Platforms

Supported means the installer accepts it and this project tests on it. Nothing
below is listed because it is likely to work.

## Control plane

| | |
| --- | --- |
| Ubuntu 24.04 LTS | supported |
| Ubuntu 22.04 LTS | supported |
| Debian 12 | supported |

The installer checks `/etc/os-release` and warns on anything else rather than
proceeding silently.

Also required:

- **Docker Engine** with the **Compose plugin** (`docker compose`, not
  `docker-compose`)
- **systemd**, for the deployment's own service management
- a **domain name** resolving to the machine, for the certificate
- **64-bit x86 (amd64)**

The control plane runs as a Docker Compose stack. That is the supported way to
run it; there is no package and no bare-metal installation.

### Ports

| Port | Reached by | Purpose |
| --- | --- | --- |
| 80/tcp | the internet | certificate issuance, and the redirect to HTTPS |
| 443/tcp | browsers | the interface and the API |
| 9443/tcp | managed hosts | the agent gateway, mutual TLS |

**9443 is not HTTP behind Caddy.** It terminates its own TLS and authenticates
the client certificate, which is the host's identity. A proxy that terminated
TLS in front of it would destroy the only thing it authenticates. If something
sits in front, it must pass TCP through.

Not published, and not reachable from outside the Compose network:

| | |
| --- | --- |
| PostgreSQL 5432 | the database |
| control server 3000 | the API, reached through Caddy |

`dockplane-control doctor` checks that both are unpublished.

## Managed hosts

| | |
| --- | --- |
| Debian 12 | supported |
| Ubuntu 24.04 LTS | supported |
| Ubuntu 22.04 LTS | supported |

Also required:

- **systemd**
- **Docker Engine**, reachable over its local socket
- **outbound access** to the control plane on 9443

Nothing needs to reach into a managed host. The agent connects outward.

Other Linux distributions with systemd and Docker can run the agent from the
tarball, installed by hand. That is not a supported configuration; the package
is.

## Architectures

| | |
| --- | --- |
| amd64 | supported and tested |
| arm64 | **experimental — built and inspected, not runtime-tested** |

**arm64 is not "supported".** The package and the binary are produced for it and
inspected — architecture, static linking, package metadata, image manifests,
bill of materials — and no arm64 machine has run them. Enrollment, discovery,
lifecycle, live logs and reboot have been verified on amd64 only. Emulation was
not used and would not count.

Use amd64 in production.

## Browsers

The interface targets current versions of Firefox, Chrome, Edge and Safari. It
is tested on Firefox and Chromium.

## Related

- [Installation](../getting-started/installation.md)
- [Known Limitations](known-limitations.md)
- [Architecture](architecture.md)
