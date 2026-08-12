# Vulnerability Assessment — 0.1.0-rc.1

Every known vulnerability in the release images, and what was decided about it.
Nothing here is dismissed for being inconvenient; each entry says why it is or
is not a reason to hold the release.

| | |
| --- | --- |
| Scanner | Trivy 0.73.0 |
| Scanned | `control-server` and `web`, both `linux/amd64` and `linux/arm64` |
| Severities | CRITICAL and HIGH |
| Release | 0.1.0-rc.1 |
| Date | 2026-08-11 |

Both architectures return identical findings; the images differ only in
compiled output.

The digests these results apply to are in `release-manifest.json`, produced by
the same build. They are not repeated here: a digest recorded in a file that is
itself part of the commit being built can never be the digest of that build.

## Result

| Image | Critical | High |
| --- | --- | --- |
| `dockplane-control-server` | 5 | 17 |
| `dockplane-web` | 0 | 10 |

**The agent binaries were not scanned.** They are statically linked Go with no
operating system underneath, and the scanner's Go analysis covers the modules
compiled in; a dedicated agent scan is listed as an open item rather than
claimed.

## What was fixed for this candidate

Three changes were made in response to the first scan, and nothing else:

| | From | To | Cleared |
| --- | --- | --- | --- |
| Caddy base | 2.10.2-alpine | 2.11.4-alpine | 6 critical, 54 high — the ACME server library, gRPC, the Go standard library, and Alpine's TLS libraries |
| Node base | 22.22.3 | 22.23.2 | several Debian findings |
| `drizzle-orm` | 0.44.5 | 0.45.2 | CVE-2026-39356 |

The runtime image also no longer contains npm. It is never executed there —
the container runs `node dist/main.js` — and it brought its own vendored
dependency tree, including the `tar` that produced a critical finding.

No major versions were changed. The full API, application and agent suites
were re-run against every one of these changes.

## The remaining criticals

All five are Debian base packages with **no fixed version available** from the
distribution.

| CVE | Package | Assessment |
| --- | --- | --- |
| CVE-2026-13221, CVE-2026-42496, CVE-2026-57433, CVE-2026-8376 | `perl-base` | Perl is present in the base image and never executed. The container's only process is `node dist/main.js`; nothing in the image invokes a shell script, and the entry points are all `node`. Reaching Perl would require executing a program the image never starts. |
| CVE-2023-45853 | `zlib1g` | The affected code is MiniZip, which Debian does not build into `zlib1g`. Node uses its own bundled zlib rather than the system one. |

These are carried, not accepted silently: when Debian publishes a fix, a
rebuild of the same commit picks it up, and the next candidate will show it.

## The remaining highs

**Control server** — 17, all Debian base packages with no fix available:
`util-linux` and its libraries (`bsdutils`, `libblkid1`, `libmount1`,
`libsmartcols1`, `libuuid1`, `mount`), `ncurses`, `gzip`, `libacl1`, and four
more in `perl-base`. Same reasoning as above: these are command-line tools and
terminal libraries in an image whose only process is a Node server with a
read-only root filesystem, no capabilities and no shell in its path.

**Web** — 10:

- `curl`, `libcurl`, `c-ares` in the Alpine base. Caddy does not shell out to
  curl; it is present because the base image includes it. Fixes exist upstream
  and will arrive with the next Alpine-based Caddy release.
- `golang.org/x/text`, `google.golang.org/grpc` and three Go standard library
  advisories compiled into the Caddy binary. Caddy 2.11.4 is the newest release
  at the time of this candidate; these are fixed in Go and module versions that
  no released Caddy yet uses. The gRPC and ACME-server code paths are not
  configured in Dockplane's Caddyfile.

## What reduces the exposure regardless

- The control server runs as uid 10001 with a read-only root filesystem, every
  capability dropped, `no-new-privileges`, and a 64 MB tmpfs as its only
  writable path.
- Caddy runs with every capability dropped except `NET_BIND_SERVICE`.
- Neither container can reach the Docker socket.
- The REST API and PostgreSQL are not published; only 80, 443 and 9443 are.

## Open items

- The agent binaries are not covered by a dedicated scan.
- No image signature. Provenance and SBOM attestations are attached to the
  images; a signature requires a signing identity the project does not yet
  have.

## Related

- [Building a Release](releases.md)
- [Security Model](../security/security-model.md)
