# Building a Release

A Dockplane release has two halves, built by one command each: the control
plane images, and the agent packages.

```bash
deploy/build-agent.sh  "$VERSION"     # agent .deb and .tar.gz for amd64 and arm64
deploy/check-agent-release.sh "$VERSION"
deploy/build-images.sh "$VERSION"     # control server and web images, and the bundle
```

That is the whole procedure, and it is the same procedure in CI: the release
workflow runs these scripts rather than reimplementing them, so a release built
by a machine and a release built by hand are built the same way. There is no
step that exists only in someone's shell history.

## What it needs

Docker with buildx, and git for the revision stamp. Nothing else — the agent is
compiled inside a pinned Go image rather than against whatever toolchain the
machine happens to have, so two builds of the same commit produce the same
binary wherever they run.

The version is stamped into both images as build arguments and reported by
`/api/v1/version` and by `dockplane-agent version`. A build made outside a git
checkout reports its commit as `unknown`, and one made from a modified working
tree marks it `-dirty`: **release from a clean checkout.**

## What it produces

```text
dist/release/
├── dockplane-<version>.tar.gz          the bundle an operator installs from
├── control-server-<version>.oci.tar    the image, as a portable archive
├── web-<version>.oci.tar
├── dockplane-agent-linux-amd64
├── dockplane-agent-linux-arm64
├── SHA256SUMS
└── release-manifest.json
```

The bundle carries the installer, the Compose stack, the operational commands
and both images, and nothing else — no source, no build tooling, no checkout.
It is packed in a container with GNU tar and `SOURCE_DATE_EPOCH`, so packing the
same content twice produces the same bytes.

and, in the local image store or in a registry:

```text
ghcr.io/dockplanee/dockplane-control-server:<version>
ghcr.io/dockplanee/dockplane-web:<version>
```

Both images carry the same tag on purpose. A deployment pins one
`DOCKPLANE_VERSION` and both images follow it: a stack is one version of
Dockplane, not a combination.

`latest` is not produced. A production deployment that follows a moving tag
cannot say what it is running and cannot be rolled back to what it was.

## The manifest

```json
{
  "version": "<version>",
  "commit": "…",
  "license": "AGPL-3.0-only",
  "maintainer": "Dockplane <info@dockplane.de>",
  "repository": "https://github.com/Dockplanee/dockplane",
  "buildDate": "…",
  "protocolVersion": 1,
  "schemaVersion": "0004_audit_action_index",
  "backupFormatVersion": 1,
  "images": {
    "controlServer": { "reference": "…", "digest": "sha256:…", "tags": [ … ], "platforms": [ … ] },
    "web": { … }
  },
  "agent": { "version": "<version>", "platforms": [ … ], "artefacts": [ { "name": "…", "sha256": "…" } ] },
  "supplyChain": { "sbom": "…", "provenance": "…", "signature": "none" }
}
```

`protocolVersion` is what agent and server must agree on; `schemaVersion` is the
last migration the build contains; `backupFormatVersion` is what a restore will
accept. Together they answer, months later, which agent works with which server,
which database, and which backup.

The digests are the ones the registry returned for this build. They are never
written back into the commit: a digest recorded in a file that is part of the
commit being built can never be the digest of that build. The manifest is a
release artefact, produced by the build and published with it.

Pass `AGENT_MANIFEST=dist/agent/release-manifest.json` and the agent packages'
checksums are folded in, so one file describes the whole release. This is what
the release workflow does, which is why it builds the agent first.

## The agent packages

`deploy/build-agent.sh` produces, for amd64 and arm64, a Debian package and a
tarball, plus `SHA256SUMS` and a manifest of its own:

```text
dist/agent/
├── dockplane-agent_<version>_amd64.deb
├── dockplane-agent_<version>_arm64.deb
├── dockplane-agent_<version>_linux_amd64.tar.gz
├── dockplane-agent_<version>_linux_arm64.tar.gz
├── SHA256SUMS
└── release-manifest.json
```

Everything is compiled and packaged in pinned containers — `golang` for the
binary, `debian:12-slim` for `dpkg-deb` — so a host with nothing but Docker
produces the artefacts, and the package is built by the same tooling that will
install it.

The build is reproducible: timestamps come from the commit through
`SOURCE_DATE_EPOCH` rather than from the clock, and building the same commit
twice — once from the repository and once from a clean export of that commit —
has been verified to produce byte-identical packages, tarballs and image
layers. It **refuses** to build without a commit it can name, because a package
reporting an unknown version is one nobody can trace back.

What is not reproducible is the provenance attestation, and it is not meant to
be: it records a build, with the times it ran and where it ran, so two builds of
one commit describe two events. That changes the digest of the manifest list
that carries it. The images underneath it are identical, and the release
manifest records the digest that was actually published.

`deploy/check-agent-release.sh` verifies the artefacts before anyone installs
them: both architectures present, checksums matching, the unit and settings
file shipped, the binary static and of the right machine type, the version
command reporting a real version — and no key, certificate, identity or token
anywhere in the package.

## Architectures

| Artefact | amd64 | arm64 |
| --- | --- | --- |
| agent binary and packages | built, inspected, runtime-tested | built and inspected, **experimental** |
| control server image | built, runtime-tested | built, **experimental** |
| web image | built, runtime-tested | built, **experimental** |

Everything is built for both architectures and inspected for both — ELF machine
type, static linking, package metadata, image platform entries. **No arm64
machine has run any of it.** Emulation is not a substitute and was not used as
one. arm64 remains experimental.

The agent cross-compiles for both and the binaries are checked to be what they
claim. The images accept a platform list:

```bash
PLATFORMS=linux/amd64,linux/arm64 PUSH=1 deploy/build-images.sh "$VERSION"
```

but that needs a buildx builder with the `docker-container` driver and emulation
for the foreign architecture; the default driver builds only for the host. The
release workflow sets both up, which is how the arm64 images are produced. They
are produced and inspected. They are not runtime-tested.

## Supply chain

Passing `SBOM=1`, or pushing, attaches a software bill of materials and full
build provenance to each image as attestations. A pushed image carries them in
the registry; a local build carries them inside the OCI archive it writes. They
are off by default for a local build because most local builds do not want the
cost of producing them.

Every release is scanned with Trivy and every critical and high finding is
assessed in writing before the release goes out — see
[Vulnerability Assessment](../security/vulnerabilities.md).

**Images are not signed.** Provenance and a software bill of materials are
attached to each image as attestations, which is not the same thing as a
signature and is not described as one. Signing needs a signing identity the
project does not have yet.

Base images are pinned by tag — `node:22.23.2-bookworm-slim`,
`caddy:2.11.4-alpine`, `postgres:17.6-bookworm` — so a rebuild does not silently
change the operating system underneath the product.

## Releasing from a tag

Publishing is done by GitHub Actions and starts with a tag. Nothing else
publishes: a push to a branch runs the gates and produces nothing, and no
workflow other than the release one has permission to write to a registry or
create a release.

```bash
git tag v0.1.0-rc.2
git push origin v0.1.0-rc.2
```

| Workflow | Runs on | Publishes |
| --- | --- | --- |
| `.github/workflows/ci.yml` | every push to `main` and every pull request | nothing |
| `.github/workflows/quality.yml` | called by the other two | nothing |
| `.github/workflows/release.yml` | a tag matching `v*` | images, a GitHub release |

### What the tag has to look like

The trigger is a glob because that is all GitHub accepts. The real gate is
`deploy/release-version.sh`, which turns a tag into a version and refuses
anything that is not one — before any job that could publish:

```text
v0.1.0-rc.2   ->  0.1.0-rc.2, published as a prerelease
v0.1.0        ->  0.1.0
main          ->  refused
v0.1.0-rc2    ->  refused
v0.1.0+build  ->  refused
```

The tag is the only thing a release build receives from outside, and it arrives
from whoever can push tags. It is read into an environment variable, matched
against one expression, and never expanded by a shell. No workflow expression is
interpolated into a shell command anywhere in these files, which is what
`deploy/test-release.sh` checks.

### What has to pass first

Every gate in `quality.yml` — the control server and the application each built,
linted, typechecked and tested; the agent gofmt-clean, vetted and tested; the
shell scripts syntax-checked, shellchecked, and the installer, backup and
release suites run. A release runs exactly what a push runs. If any of it fails,
nothing is pushed to the registry and no release is created.

### What it publishes

```text
ghcr.io/dockplanee/dockplane-control-server:0.1.0-rc.2
ghcr.io/dockplanee/dockplane-web:0.1.0-rc.2
```

One tag each, and it is the version a deployment pins through
`DOCKPLANE_VERSION`. `latest` is not produced: a deployment that follows a
moving tag cannot say what it is running.

Authentication is the workflow's own short-lived token. **No registry password
or personal access token is stored in this repository**, and nothing prints a
credential.

**Package visibility is not set by the workflow.** It is read after the push and
reported in the job summary, because a test distribution that quietly became
public is worth noticing at the moment it happens.

The GitHub release carries the bundle, both agent packages, both agent tarballs,
the release manifest, the SBOM and provenance documents, the vulnerability
reports, one `SHA256SUMS` over all of them, and the release notes from
`docs/releases/<version>.md`. A release with no notes is refused before anything
is built. A pre-release version is marked as a prerelease.

None of this is committed back. Build output is release output; it belongs in
the release and in the registry, not in the history it was built from.

### The vulnerability gate

Trivy scans the published images, per architecture, and
`deploy/check-vulnerabilities.sh` applies the policy:

| | |
| --- | --- |
| a critical with a fix available | stops the release |
| a critical nobody has assessed | stops the release |
| a critical assessed in `deploy/accepted-vulnerabilities.txt` | carried, with the reason |
| a high with a fix available | reported, and stops nothing |

An assessment that no longer matches anything is reported too: a stale
assessment is how a real finding eventually gets waved through.

### Actions used

Pinned to a commit, with the version they were recorded next to them. A tag can
be moved; a commit cannot.

| Action | Why |
| --- | --- |
| `actions/checkout` | the source, checked out without leaving a token in `.git/config` |
| `actions/setup-node`, `actions/setup-go` | the toolchains the images are built with |
| `actions/upload-artifact`, `actions/download-artifact` | passing artefacts between jobs |
| `docker/setup-buildx-action`, `docker/setup-qemu-action` | multi-architecture builds |

Everything else is a container image pinned to a version — `aquasec/trivy`,
`koalaman/shellcheck`, `golang`, `debian` — or the `gh` CLI that the runner
already has. There are no third-party actions.

## Related

- [Installation](../getting-started/installation.md)
- [Troubleshooting](troubleshooting.md)
