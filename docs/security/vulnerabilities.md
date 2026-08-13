# Vulnerability Assessment

Every release is scanned, both images on both architectures, and the report for
each is published as a release asset. This page is the assessment behind those
numbers: what is in them, what was fixed, and why what remains is still there.

The figures below are from **0.2.0-rc.1**, the last release scanned at the time
of writing. They are what its published reports contain, not a summary of them.

Nothing is hidden. A finding that cannot be fixed is named, along with the
reason it is not being treated as a release blocker.

```bash
# The reports published with a release
VERSION=0.2.0-rc.1
curl -fsSLO "https://github.com/Dockplanee/dockplane/releases/download/v$VERSION/vulnerabilities-control-server-linux-amd64.json"
```

## The policy

A **critical** finding with a fix available stops a release. Everything else is
recorded, assessed and carried, and the assessment is on this page rather than
in somebody's head.

The scanner is Trivy, at a pinned version, with `--ignore-unfixed=false` — so
findings with no available fix are counted rather than hidden. There is no
ignore file: a finding that is not relevant is explained here, not suppressed.

## Control server

Base: `node:22-bookworm-slim` (Debian 12).

| | |
| --- | --- |
| Critical | 5 |
| High | 17 |
| **With a fix available** | **0** |
| From application dependencies | 0 |

Every finding is a Debian 12 package for which Debian has published no fixed
version. There is no newer base image to move to: the pinned Node version is
the newest of its line, and rebuilding produces the same set.

**No finding comes from Dockplane's own dependencies.** The npm tree scans
clean, and so does the Compose compiler, the Go binary this image carries to
turn a Compose file into a deployment plan.

### The critical findings

| CVE | Package | Assessment |
| --- | --- | --- |
| CVE-2026-13221 | perl-base | Perl is never executed. The runtime starts `node dist/main.js`; nothing in the control server invokes an interpreter, and no request path reaches one. `perl-base` is present because Debian's base image includes it and `dpkg` depends on it. |
| CVE-2026-42496 | perl-base | As above. |
| CVE-2026-57433 | perl-base | As above. |
| CVE-2026-8376 | perl-base | As above. |
| CVE-2023-45853 | zlib1g | The vulnerable code is in zlib's bundled MiniZip contributed component, which is not built into the shared library Debian ships or linked by Node. Debian assesses the packaged library as unaffected. |

None is reachable through the control server's own surface. Each remains in the
image because removing a package that `dpkg` depends on would leave an image
that cannot be reasoned about, and no distribution offers a fixed one.

### What would change this

Moving the runtime to a base without a Perl interpreter, either Alpine or a
minimal image. That is a change to how the control server is built — the
password hashing library is a native module with a package per platform and per
C library — and it belongs in a release of its own rather than in hardening an
existing one.

## Web

Base: `caddy:2.11.4-alpine`.

| | 0.1.0-rc.3 | 0.1.0-rc.4 | 0.2.0-rc.1 |
| --- | --- | --- | --- |
| Critical | 0 | 0 | **0** |
| High | 10 | 6 | **6** |

Five Alpine package findings were removed in 0.1.0-rc.4 by applying the
distribution's own updates. One was added there: `CVE-2026-46600` appeared in
the vulnerability database between those two releases, in a component that was
already present. 0.2.0-rc.1 carries the same six, for the reason below.

### Fixed

Alpine had published fixes that the Caddy image did not yet carry, because
Caddy publishes an image per release and does not rebuild it when its base is
patched. The image now applies Alpine's own security updates, from Alpine's own
repositories, in a layer of its own.

| CVE | Package | Installed | Fixed in |
| --- | --- | --- | --- |
| CVE-2026-5773 | curl, libcurl | 8.19.0-r0 | 8.20.0-r0 |
| CVE-2026-6276 | curl, libcurl | 8.19.0-r0 | 8.20.0-r0 |
| CVE-2026-33630 | c-ares | 1.34.6-r0 | 1.34.8-r0 |

No package version is pinned by hand and no third-party repository is added.
The cost is that the same Dockerfile builds different bytes once Alpine
publishes an update; the release manifest records the digest actually
published.

### Remaining

Six, every one of them inside `/usr/bin/caddy`:

| CVE | Component | Installed | Fixed in |
| --- | --- | --- | --- |
| CVE-2026-27145 | Go standard library | 1.26.3 | 1.26.4 |
| CVE-2026-39822 | Go standard library | 1.26.3 | 1.26.5 |
| CVE-2026-42504 | Go standard library | 1.26.3 | 1.26.4 |
| CVE-2026-46600 | golang.org/x/net | 0.55.0 | 0.56.0 |
| CVE-2026-56852 | golang.org/x/text | 0.37.0 | 0.39.0 |
| GHSA-hrxh-6v49-42gf | google.golang.org/grpc | 1.81.0 | 1.82.1 |

**CVE-2026-46600** is a denial of service in
`golang.org/x/net/dns/dnsmessage`, reached by parsing an invalid DNS record.
Caddy resolves names — for upstreams and for ACME challenges — so the parser is
present. The consequence is availability of the reverse proxy; it discloses
nothing and grants nothing.

Every one of the six is compiled into the Caddy executable rather than
installed as a package, so none can be patched from a repository. Fixing them
means Caddy rebuilding against newer dependencies and publishing a release.
**2.11.4 is the newest Caddy release, and it carries these versions**, so there
is nothing to upgrade to. Dockplane does not build Caddy from source; a
privately built reverse proxy would be a larger operational risk than these
findings.

They are tracked. When Caddy publishes a release built on newer dependencies,
the pinned version moves and this table shrinks.

## What is not covered

**Images are not signed.** A bill of materials and build provenance are
attached to each image as attestations. That is evidence of how an image was
built, not a signature.

The agent is a static Go binary, published as a `.deb` and a tarball rather
than an image, and is not scanned by this pipeline. Its dependencies are
covered by the Go module checks in CI.

## Related

- [Security Model](security-model.md)
- [Known Limitations](../reference/known-limitations.md)
- [Building a Release](../operations/releases.md)
