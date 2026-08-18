# Vulnerability Assessment

Every release is scanned and the report for each artefact is published as a
release asset: both control-plane images on both architectures, and — from
0.3.0 — the agent binary on both architectures. This page is the assessment
behind those numbers: what is in them, what was fixed, and why what remains is
still there.

The figures below are from **0.3.0**. They are what its published reports
contain, not a summary of them.

Nothing is hidden. A finding that cannot be fixed is named, along with the
reason it is not being treated as a release blocker.

```bash
# The reports published with a release
VERSION=0.3.0
curl -fsSLO "https://github.com/Dockplanee/dockplane/releases/download/v$VERSION/vulnerabilities-control-server-linux-amd64.json"
```

**amd64 and arm64 report the same findings.** Each table below is either
architecture; the six reports differ only in the artefact they name.

## The policy

A **critical** finding with a fix available stops a release. Everything else is
recorded, assessed and carried, and the assessment is on this page rather than
in somebody's head.

The scanner is Trivy — `0.73.0` for this release, as recorded in each report —
with `--ignore-unfixed=false`, so findings with no available fix are counted
rather than hidden. There is no ignore file: a finding that is not relevant is
explained here, not suppressed.

## Control server

Base: `node:22-bookworm-slim` (Debian 12.15). The image is scanned as three
things: the distribution's packages, the npm tree, and the Go binary it
carries.

| | Debian packages | npm tree | Compose compiler | Total |
| --- | --- | --- | --- | --- |
| Critical | 5 | 0 | 0 | **5** |
| High | 17 | 0 | 0 | **17** |
| With a fix available | 0 | — | 0 | **0** |

**Every finding in this image is a Debian package finding, and none has a fix
available.** Neither the control server's own JavaScript dependencies nor the Go
binary it carries contributes one.

### The Debian findings

Every one is a Debian 12 package for which Debian has published no fixed
version. There is no newer base image to move to: the pinned Node version is
the newest of its line, and rebuilding produces the same set.

The seventeen high findings are eight distinct CVEs, counted once per affected
package: four in `perl-base`, one across the eight `util-linux` packages, one
across the three `ncurses` packages, and one each in `gzip` and `libacl1`.

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

### The Compose compiler

`dockplane-compose-compiler` is the Go binary this image carries to turn a
Compose file into a deployment plan. It is built with Go 1.26.6 and the scan
reports nothing in it, at any severity.

`0.3.0-rc.2` was built with Go 1.26.5 and carried eight high findings in that
toolchain's standard library: CVE-2026-33818, CVE-2026-39821, CVE-2026-46600,
CVE-2026-56853, CVE-2026-56858, CVE-2026-56859, CVE-2026-56860 and
CVE-2026-56862, each fixed in 1.26.6. Moving `GO_VERSION` in `api/Dockerfile`
to 1.26.6 resolved all eight, and they are not in this release.

That statement is about this binary. Caddy, in the web image, is built by its
own project against its own toolchain and carries standard-library findings of
its own; they are in the Web section below.

The compiler is run by the control server as a child process, with an argument
list and never through a shell, on a Compose file an operator saved. It listens
on nothing, and no managed host reaches it.

## Web

Base: `caddy:2.11.4-alpine`.

| | 0.1.0-rc.3 | 0.1.0-rc.4 | 0.2.0-rc.1 | 0.3.0-rc.2 | 0.3.0 |
| --- | --- | --- | --- | --- | --- |
| Critical | 0 | 0 | 0 | 0 | **0** |
| High | 10 | 6 | 6 | 14 | **14** |

All fourteen are reported with a fix available, and none of them is in a binary
this project builds.

Five Alpine package findings were removed in 0.1.0-rc.4 by applying the
distribution's own updates. One was added there: `CVE-2026-46600` appeared in
the vulnerability database between those two releases, in a component that was
already present. 0.2.0-rc.1 carried the same six.

**The Alpine layer scans clean** — no finding of any severity in a distribution
package. Every one of the fourteen is inside `/usr/bin/caddy`.

The count went from six in `0.2.0-rc.1` to fourteen without the binary changing.
Caddy is still `2.11.4`, built against the same module versions; eight further
CVEs were published against those versions in the meantime. Nothing regressed
and nothing was introduced — what is known about the same bytes grew, and 0.3.0
carries the same fourteen.

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

Fourteen, every one of them inside `/usr/bin/caddy`:

| CVE | Component | Installed | Fixed in |
| --- | --- | --- | --- |
| CVE-2026-27145 | Go standard library | 1.26.3 | 1.26.4 |
| CVE-2026-33818 | Go standard library | 1.26.3 | 1.26.6 |
| CVE-2026-39821 | Go standard library | 1.26.3 | 1.26.6 |
| CVE-2026-39822 | Go standard library | 1.26.3 | 1.26.5 |
| CVE-2026-42504 | Go standard library | 1.26.3 | 1.26.4 |
| CVE-2026-46600 | Go standard library | 1.26.3 | 1.26.6 |
| CVE-2026-56853 | Go standard library | 1.26.3 | 1.26.6 |
| CVE-2026-56858 | Go standard library | 1.26.3 | 1.26.6 |
| CVE-2026-56859 | Go standard library | 1.26.3 | 1.26.6 |
| CVE-2026-56860 | Go standard library | 1.26.3 | 1.26.6 |
| CVE-2026-56862 | Go standard library | 1.26.3 | 1.26.6 |
| CVE-2026-46600 | golang.org/x/net | 0.55.0 | 0.56.0 |
| CVE-2026-56852 | golang.org/x/text | 0.37.0 | 0.39.0 |
| GHSA-hrxh-6v49-42gf | google.golang.org/grpc | 1.81.0 | 1.82.1 |

**CVE-2026-46600** is a denial of service in `dns/dnsmessage`, reached by
parsing an invalid DNS record; it is reported twice, once against
`golang.org/x/net` and once against the standard library that vendors the same
parser. Caddy resolves names — for upstreams and for ACME challenges — so the
parser is present. The consequence is availability of the reverse proxy; it
discloses nothing and grants nothing.

Every one of the fourteen is compiled into the Caddy executable rather than
installed as a package, so none can be patched from a repository. Fixing them
means Caddy rebuilding against newer dependencies and publishing a release.
**2.11.4 is the newest Caddy release, and it carries these versions**, so there
is nothing to upgrade to. Dockplane does not build Caddy from source; a
privately built reverse proxy would be a larger operational risk than these
findings.

They are tracked. When Caddy publishes a release built on newer dependencies,
the pinned version moves and this table shrinks.

## The agent

The agent is the artefact that ends up on every managed host, and until 0.3.0
nothing scanned it: it is a native binary in a package and a tarball rather than
an image, and the pipeline scanned images.

From 0.3.0 it is scanned on both architectures and both reports are published,
as `vulnerabilities-agent-linux-amd64.json` and
`vulnerabilities-agent-linux-arm64.json`. The binary read is the one that was
published — taken out of the release tarball rather than built again — so the
report and the artefact cannot describe different bytes. Scanner, severities and
policy are the ones the images are held to; there is no separate rule for the
agent and no ignore file.

`0.3.0-rc.2` was built before this and published no agent report, so 0.3.0 is
the first release with agent figures.

| | linux/amd64 | linux/arm64 |
| --- | --- | --- |
| Critical | 0 | **0** |
| High | 3 | **3** |
| With a fix available | 1 | **1** |

All three are recorded against `github.com/docker/docker`, the Docker Engine's
Go client, at `v28.5.2+incompatible`:

| CVE | Fixed in |
| --- | --- |
| CVE-2026-34040 | Docker Engine 29.3.1 |
| CVE-2026-41567 | no fixed version published |
| CVE-2026-42306 | no fixed version published |

The agent is built with the same Go toolchain as the Compose compiler, Go
1.26.6, and the scan reports no standard-library finding in it.

### Findings recorded against the Docker repository

The agent links the Docker Engine's Go client, and the scanner reads that
module's version. Docker publishes the daemon and the client from one
repository, so a finding recorded against it is reported against the agent
whether the affected code is in the client or in the daemon — and the fixed
version named is an Engine release, which may not exist as a version of the Go
module the agent imports.

Such a finding has to be read against the code paths the agent actually uses.
The agent has no archive or `docker cp` surface, no exec, no attach and no
plugin surface; a vulnerability in one of those is not reachable through
anything the agent exposes. What remains of the risk belongs to the Docker
Engine version installed on the managed host, not to a daemon function the agent
provides — which is a reason to keep Docker Engine current, not a reason to read
the finding as inapplicable.

These findings are not suppressed. They stay in the published report, and the
assessment belongs here.

## What is not covered

**Images are not signed.** A bill of materials and build provenance are
attached to each image as attestations. That is evidence of how an image was
built, not a signature.

**The agent has no bill of materials and no provenance document.** Both are
attestations the image builder produces, and the agent is not an image. Its
artefacts are covered by the release checksums and by the scan described below,
which is not the same evidence. Its dependencies are
covered by the Go module checks in CI.

## Related

- [Security Model](security-model.md)
- [Known Limitations](../reference/known-limitations.md)
- [Building a Release](../operations/releases.md)
