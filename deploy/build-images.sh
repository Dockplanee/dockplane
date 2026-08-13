#!/usr/bin/env bash
#
# Builds the Dockplane release artefacts and writes a manifest describing them.
#
#   deploy/build-images.sh 0.1.0
#   PLATFORMS=linux/amd64,linux/arm64 PUSH=1 deploy/build-images.sh 0.1.0
#
# Everything a release consists of is produced here: the two control-plane
# images, the agent binaries, and the manifest that says which of them belong
# together. There is no step that is only in someone's shell history.

set -euo pipefail

VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
	echo "usage: $0 <version>   e.g. $0 0.1.0" >&2
	exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

API_IMAGE="${DOCKPLANE_API_IMAGE:-ghcr.io/dockplanee/dockplane-control-server}"

# Named once, so the manifest and the image labels cannot drift apart.
MAINTAINER="${DOCKPLANE_MAINTAINER:-Dockplane <info@dockplane.de>}"
REPOSITORY="${DOCKPLANE_REPOSITORY:-https://github.com/Dockplanee/dockplane}"
WEB_IMAGE="${DOCKPLANE_WEB_IMAGE:-ghcr.io/dockplanee/dockplane-web}"

# Multi-architecture builds need a buildx builder that can emit more than one
# platform. A single-platform build loads straight into the local daemon.
PLATFORMS="${PLATFORMS:-linux/amd64}"
# Pinned, so the agent is not built against whatever toolchain is to hand.
GO_VERSION="${GO_VERSION:-1.26.5}"
AGENT_PLATFORMS="${AGENT_PLATFORMS:-linux/amd64 linux/arm64}"
PUSH="${PUSH:-0}"

# The bundle is packed in this image rather than by the host's tar: GNU tar
# sorts and stamps deterministically and BSD tar cannot, so a release packed on
# a developer machine would otherwise differ from the same commit packed in CI.
DEBIAN_IMAGE="${DEBIAN_IMAGE:-debian:12-slim}"

# The agent's own release manifest, when the agent artefacts were built first.
# Its checksums are folded into this manifest so one file describes the whole
# release instead of two that have to be read together.
AGENT_MANIFEST="${AGENT_MANIFEST:-}"

# Checked before anything is built, so a machine missing a toolchain does not
# produce half a release and a manifest describing artefacts that do not exist.
missing=()
for tool in docker git sha256sum tar; do
	command -v "$tool" > /dev/null || missing+=("$tool")
done

# Every image here is built by buildx. Docker without it produces no
# multi-architecture image and no attestation.
command -v docker > /dev/null && { docker buildx version > /dev/null 2>&1 || missing+=("docker buildx"); }

# Only needed to fold an agent manifest in, so a build without one does not
# require it.
if [[ -n "$AGENT_MANIFEST" ]]; then
	command -v jq > /dev/null || missing+=(jq)
fi

if [[ ${#missing[@]} -gt 0 ]]; then
	echo "missing on this machine: ${missing[*]}" >&2
	echo "A release machine needs Docker with buildx and git for the revision stamp." >&2
	echo "The Go toolchain is not installed here; the agent is built in a pinned image." >&2
	exit 3
fi

# A release says which source it came from, the same way the agent release
# does. Both may be supplied explicitly, which is what a build system does when
# it exports a tree without its history.
COMMIT="${DOCKPLANE_COMMIT:-$(git rev-parse HEAD 2>/dev/null || true)}"

if [[ -z "$COMMIT" ]]; then
	echo "no commit: build from a git checkout, or set DOCKPLANE_COMMIT" >&2
	exit 4
fi

if [[ -z "${DOCKPLANE_COMMIT:-}" && -n "$(git status --porcelain 2>/dev/null)" ]]; then
	COMMIT="${COMMIT}-dirty"
fi
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Reproducible: the bundle's timestamps come from the commit rather than from
# the clock, so packing the same commit twice produces the same archive. This
# refuses rather than falling back to the clock, because an archive that is
# quietly not reproducible is worse than one that was never built.
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --pretty=%ct 2> /dev/null || true)}"

if [[ -z "$SOURCE_DATE_EPOCH" ]]; then
	echo "no commit date: build from a git checkout, or set SOURCE_DATE_EPOCH" >&2
	exit 4
fi

OUT="${OUT:-$REPO_ROOT/dist/release}"
mkdir -p "$OUT"

echo "==> Dockplane $VERSION  ($COMMIT)"
echo "    platforms: $PLATFORMS"

build_args=(
	--build-arg "DOCKPLANE_VERSION=$VERSION"
	--build-arg "DOCKPLANE_COMMIT=$COMMIT"
	--build-arg "DOCKPLANE_BUILD_DATE=$BUILD_DATE"
	--platform "$PLATFORMS"
)

# A software bill of materials and build provenance, attached to the image as
# attestations. They are stored alongside the image when it is pushed, so this
# is on by default for a push and off for a local build, where there is nowhere
# to keep them.
if [[ "${SBOM:-$PUSH}" == "1" ]]; then
	build_args+=(--sbom=true --provenance=mode=max)
fi

if [[ "$PUSH" == "1" ]]; then
	# Written out rather than as --push, so it composes with the archive output
	# below: a release both pushes to a registry and ships an offline bundle.
	build_args+=(--output "type=image,push=true")
elif [[ "$PLATFORMS" != *,* ]]; then
	# A single platform can be loaded into the local daemon; several cannot.
	build_args+=(--load)
fi

# A multi-platform image has nowhere to live in the local daemon, so it is
# written as an OCI archive. That is a real, portable artefact with real
# digests — `docker load` reads it, and so does a later push — rather than
# something that exists only in a build cache. It is also what the release
# bundle installs from, which is why a pushing build can be asked for one too.
if [[ -n "${OCI_ARCHIVES:-}" ]]; then
	:
elif [[ "$PUSH" == "1" || "$PLATFORMS" != *,* ]]; then
	OCI_ARCHIVES=0
else
	OCI_ARCHIVES=1
fi

oci_export() {
	local name="$1"

	[[ "$OCI_ARCHIVES" == "1" ]] || return 0

	echo "--output" "type=oci,dest=$OUT/$name-$VERSION.oci.tar"
}

# buildx records what it produced here, which is where the digest comes from.
metadata_file() {
	echo "--metadata-file" "$OUT/$1-metadata.json"
}

echo "==> control server image"
# The helpers above print flag pairs; the split into separate arguments is the
# point, and quoting them would pass one argument containing a space.
# shellcheck disable=SC2046
docker buildx build "${build_args[@]}" \
	$(oci_export control-server) $(metadata_file control-server) \
	--tag "$API_IMAGE:$VERSION" \
	--file api/Dockerfile \
	--build-arg "GO_VERSION=$GO_VERSION" \
	.

echo "==> web image"
# shellcheck disable=SC2046
docker buildx build "${build_args[@]}" \
	$(oci_export web) $(metadata_file web) \
	--tag "$WEB_IMAGE:$VERSION" \
	--file app/Dockerfile \
	app

# The agent is compiled in a pinned Go image rather than against whatever
# toolchain the release machine happens to have. Two builds of the same commit
# then produce the same binary wherever they are run.
echo "==> agent binaries (Go ${GO_VERSION})"
AGENT_VERSION="$VERSION"
for platform in $AGENT_PLATFORMS; do
	goos="${platform%%/*}"
	goarch="${platform##*/}"
	output="dockplane-agent-${goos}-${goarch}"

	docker run --rm \
		-v "$REPO_ROOT/agent:/src:ro" \
		-v "$OUT:/out" \
		-e CGO_ENABLED=0 -e GOOS="$goos" -e GOARCH="$goarch" \
		-e GOFLAGS=-buildvcs=false \
		-w /src \
		"golang:${GO_VERSION}" \
		go build -trimpath \
		-ldflags "-s -w -X main.version=$AGENT_VERSION -X main.commit=$COMMIT" \
		-o "/out/$output" ./cmd/dockplane-agent

	echo "    $output  $(du -h "$OUT/$output" | cut -f1)"
done

(cd "$OUT" && sha256sum dockplane-agent-* > SHA256SUMS)

# The schema version is the last migration the build contains, and the protocol
# version is what agent and server agree on. Both are part of what makes one
# release compatible with another.
SCHEMA_VERSION="$(grep -o '"tag": *"[^"]*"' api/src/database/migrations/meta/_journal.json | tail -1 | sed 's/.*"tag": *"//;s/"$//')"
PROTOCOL_VERSION="$(grep -oE '^export const PROTOCOL_VERSION = [0-9]+' api/src/agents/protocol.ts | grep -oE '[0-9]+$')"
# The third frozen interface: what a restore will accept.
BACKUP_FORMAT_VERSION="$(grep -oE '^BACKUP_FORMAT_VERSION=[0-9]+' deploy/backup-restore.sh | grep -oE '[0-9]+$')"

# The digest of the manifest list — the one a deployment would pin — read from
# what buildx recorded rather than guessed at.
#
# A release that cannot say which bytes it published has nothing to pin, so this
# stops rather than writing a placeholder into the manifest. A word like
# "unknown" would satisfy every later check that only asks whether a digest is
# there.
digest() {
	local name="$1" reference="$2"
	local metadata="$OUT/$name-metadata.json"
	local value=""

	if [[ -f "$metadata" ]]; then
		value="$(grep -o '"containerimage.digest": *"[^"]*"' "$metadata" |
			head -1 | sed 's/.*"\(sha256:[^"]*\)"/\1/')"
	fi

	if [[ -z "$value" ]]; then
		value="$(docker image inspect --format 'sha256:{{.Id}}' "$reference" 2> /dev/null |
			sed 's/sha256:sha256:/sha256:/')"
	fi

	if [[ ! "$value" =~ ^sha256:[0-9a-f]{64}$ ]]; then
		echo "no digest for $reference: the release cannot name what it published" >&2
		exit 4
	fi

	printf '%s' "$value"
}

# Each platform's own image digest, out of the OCI index in the archive.
platform_digests() {
	local archive="$OUT/$1-$VERSION.oci.tar"

	[[ -f "$archive" ]] || return 0

	local index
	index="$(tar -xOf "$archive" index.json 2>/dev/null || true)"
	local list
	list="$(grep -o '"digest":"sha256:[a-f0-9]*"' <<< "$index" | head -1 | grep -o 'sha256:[a-f0-9]*')"
	[[ -n "$list" ]] || return 0

	tar -xOf "$archive" "blobs/sha256/${list#sha256:}" 2>/dev/null |
		tr '}' '}\n' | grep -oE '"digest":"sha256:[a-f0-9]+"[^}]*"platform"|"architecture":"[a-z0-9]+"' |
		head -8 || true
}

# The agent packages are built before the images when a release needs one
# manifest to describe both. Without them, this build knows only about the
# binaries it compiled itself.
agent_artefacts=""

if [[ -n "$AGENT_MANIFEST" ]]; then
	if [[ ! -f "$AGENT_MANIFEST" ]]; then
		echo "no such agent manifest: $AGENT_MANIFEST" >&2
		exit 3
	fi

	agent_artefacts="$(jq '.artefacts' "$AGENT_MANIFEST" | sed '2,$s/^/    /')"
fi

cat > "$OUT/release-manifest.json" <<JSON
{
  "version": "$VERSION",
  "commit": "$COMMIT",
  "license": "AGPL-3.0-only",
  "maintainer": "$MAINTAINER",
  "repository": "$REPOSITORY",
  "buildDate": "$BUILD_DATE",
  "protocolVersion": $PROTOCOL_VERSION,
  "schemaVersion": "$SCHEMA_VERSION",
  "backupFormatVersion": $BACKUP_FORMAT_VERSION,
  "images": {
    "controlServer": {
      "reference": "$API_IMAGE:$VERSION",
      "digest": "$(digest control-server "$API_IMAGE:$VERSION")",
      "platforms": [$(printf '"%s",' ${PLATFORMS//,/ } | sed 's/,$//')],
      "archive": "$([[ -f "$OUT/control-server-$VERSION.oci.tar" ]] && echo "control-server-$VERSION.oci.tar" || echo "")"
    },
    "web": {
      "reference": "$WEB_IMAGE:$VERSION",
      "digest": "$(digest web "$WEB_IMAGE:$VERSION")",
      "platforms": [$(printf '"%s",' ${PLATFORMS//,/ } | sed 's/,$//')],
      "archive": "$([[ -f "$OUT/web-$VERSION.oci.tar" ]] && echo "web-$VERSION.oci.tar" || echo "")"
    }
  },
  "agent": {
    "version": "$AGENT_VERSION",
    "platforms": [$(printf '"%s",' $AGENT_PLATFORMS | sed 's/,$//')],
    "checksums": "SHA256SUMS"$([[ -n "$agent_artefacts" ]] && echo ",
    \"artefacts\": $agent_artefacts")
  },
  "supplyChain": {
    "sbom": "$([[ "${SBOM:-$PUSH}" == "1" ]] && echo "attached as an image attestation" || echo "not generated for this build")",
    "provenance": "$([[ "${SBOM:-$PUSH}" == "1" ]] && echo "attached as an image attestation" || echo "not generated for this build")",
    "signature": "none"
  }
}
JSON

# --- the bundle an operator actually installs from --------------------------
#
# Everything needed to stand up a control plane, and nothing else: the
# installer, the Compose stack it deploys, the operational commands, and the
# images. No repository checkout, no build tooling, no source.
echo "==> release bundle"

BUNDLE="$OUT/dockplane-$VERSION"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/compose" "$BUNDLE/images"

install -m 0755 deploy/install-control-plane.sh "$BUNDLE/install-control-plane.sh"
# Laid out exactly as deploy/ is, so the installer finds everything by the
# same relative paths whether it runs from a checkout or from a bundle.
install -m 0755 deploy/dockplane-control "$BUNDLE/dockplane-control"
install -m 0644 deploy/backup-restore.sh "$BUNDLE/backup-restore.sh"
install -m 0644 deploy/compose/compose.yaml "$BUNDLE/compose/compose.yaml"
install -m 0644 deploy/compose/Caddyfile "$BUNDLE/compose/Caddyfile"
install -m 0644 deploy/compose/.env.example "$BUNDLE/compose/.env.example"
install -m 0644 LICENSE "$BUNDLE/LICENSE"
install -m 0644 "$OUT/release-manifest.json" "$BUNDLE/release-manifest.json"

for archive in "$OUT/control-server-$VERSION.oci.tar" "$OUT/web-$VERSION.oci.tar"; do
	[[ -f "$archive" ]] && install -m 0644 "$archive" "$BUNDLE/images/$(basename "$archive")"
done

cat > "$BUNDLE/README" <<README
Dockplane $VERSION

  ./install-control-plane.sh --domain dockplane.example.com

Requires Ubuntu 24.04, Ubuntu 22.04 or Debian 12, with Docker Engine and the
Compose plugin already installed. The installer does not install Docker.

The images in images/ are loaded automatically if they are not already
present. Verify this bundle before running it:

  sha256sum -c SHA256SUMS

Licensed under the GNU Affero General Public License v3 only; see LICENSE.
README

# Packed in a container rather than by the host's tar. GNU tar sorts and stamps
# deterministically and gzip -n leaves its own timestamp out; BSD tar does
# neither, so a bundle packed on a developer machine would differ from the same
# commit packed in CI and the checksums would be hiding it.
docker run --rm \
	-v "$OUT:/work" \
	-e SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
	-w /work \
	"$DEBIAN_IMAGE" \
	sh -c "tar --format=gnu --sort=name --owner=0 --group=0 --numeric-owner --no-xattrs \
		--mtime=@$SOURCE_DATE_EPOCH -cf - 'dockplane-$VERSION' \
		| gzip -n > 'dockplane-$VERSION.tar.gz' \
		&& chown $(id -u):$(id -g) 'dockplane-$VERSION.tar.gz'"

rm -rf "$BUNDLE"

(cd "$OUT" && shasum -a 256 "dockplane-$VERSION.tar.gz" dockplane-agent-* 2> /dev/null > SHA256SUMS ||
	sha256sum "dockplane-$VERSION.tar.gz" dockplane-agent-* > SHA256SUMS)

echo "    dockplane-$VERSION.tar.gz  $(du -h "$OUT/dockplane-$VERSION.tar.gz" | cut -f1)"

echo "==> manifest"
cat "$OUT/release-manifest.json"
