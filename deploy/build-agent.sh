#!/usr/bin/env bash
#
# Builds the Dockplane agent release artefacts.
#
#   deploy/build-agent.sh 0.1.0
#
# Produces, for linux/amd64 and linux/arm64: a Debian package, a tarball, and
# the checksums over both. Everything runs in pinned containers, so a host with
# nothing but Docker produces the same artefacts as a developer machine.

set -euo pipefail

VERSION="${1:-}"

# Debian's version grammar is narrower than a marketing version string, and a
# package that cannot be compared cannot be upgraded.
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.~+-][0-9A-Za-z.~+]+)?$ ]]; then
	echo "usage: $0 <version>   e.g. $0 0.1.0 or 0.1.0~rc1" >&2
	exit 2
fi

# shellcheck source=deploy/release-assets.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-assets.sh"

# The tilde goes in the package's Version field and nowhere else. See
# deploy/release-assets.sh for why the file name must not carry it.
DEBIAN_VERSION="$(debian_version "$VERSION")"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v docker > /dev/null; then
	echo "docker is required: the Go toolchain and dpkg both run in containers" >&2
	exit 3
fi

GO_VERSION="${GO_VERSION:-1.26.5}"
# dpkg-deb comes from the distribution the package targets, so the package is
# built by the same tooling that will install it.
DEBIAN_IMAGE="${DEBIAN_IMAGE:-debian:12-slim}"
ARCHITECTURES="${ARCHITECTURES:-amd64 arm64}"

# A package identifies a person who is responsible for it. Override this for a
# real distribution; the default is deliberately a reserved, undeliverable
# domain rather than a plausible address nobody reads.
MAINTAINER="${DOCKPLANE_MAINTAINER:-Dockplane <info@dockplane.de>}"

# A release says which source it came from. A package reporting an unknown
# commit and a 1970 build date is not something anyone can trace back, so this
# refuses rather than producing one. Both may be supplied explicitly, which is
# what a build system does when it exports a tree without its history.
COMMIT="${DOCKPLANE_COMMIT:-$(git rev-parse HEAD 2> /dev/null || true)}"

if [[ -z "$COMMIT" ]]; then
	echo "no commit: build from a git checkout, or set DOCKPLANE_COMMIT" >&2
	exit 4
fi

if [[ -z "${DOCKPLANE_COMMIT:-}" && -n "$(git status --porcelain 2> /dev/null)" ]]; then
	COMMIT="${COMMIT}-dirty"
fi

# Reproducible: every timestamp in the artefacts comes from the commit rather
# than from the clock, so building the same commit twice produces the same
# bytes. SOURCE_DATE_EPOCH is the convention the tooling already understands.
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --pretty=%ct 2> /dev/null || true)}"

if [[ -z "$SOURCE_DATE_EPOCH" ]]; then
	echo "no build date: build from a git checkout, or set SOURCE_DATE_EPOCH" >&2
	exit 4
fi
BUILD_DATE="$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2> /dev/null ||
	date -u -r "$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"

OUT="${OUT:-$REPO_ROOT/dist/agent}"
rm -rf "$OUT"
mkdir -p "$OUT"

PROTOCOL_VERSION="$(grep -oE '^const Version = [0-9]+' agent/internal/protocol/protocol.go | grep -oE '[0-9]+$')"

echo "==> dockplane-agent $VERSION  ($COMMIT)"
[[ "$DEBIAN_VERSION" != "$VERSION" ]] && echo "    debian package version: $DEBIAN_VERSION"
echo "    protocol v$PROTOCOL_VERSION, built $BUILD_DATE"

for arch in $ARCHITECTURES; do
	echo "==> linux/$arch"

	binary="$OUT/build/$arch/dockplane-agent"
	mkdir -p "$(dirname "$binary")"

	# Static, stripped, and with the build path rewritten so the binary does
	# not carry the directory it happened to be built in.
	docker run --rm \
		-v "$REPO_ROOT/agent:/src:ro" \
		-v "$OUT/build/$arch:/out" \
		-e CGO_ENABLED=0 -e GOOS=linux -e GOARCH="$arch" \
		-e GOFLAGS=-buildvcs=false \
		-w /src \
		"golang:${GO_VERSION}" \
		go build -trimpath \
		-ldflags "-s -w -X main.version=$VERSION -X main.commit=$COMMIT -X main.buildDate=$BUILD_DATE" \
		-o /out/dockplane-agent ./cmd/dockplane-agent

	# --- the package tree -------------------------------------------------
	root="$OUT/deb/$arch"
	rm -rf "$root"
	install -d -m 0755 "$root/usr/bin" "$root/usr/lib/systemd/system" \
		"$root/etc/dockplane-agent" "$root/usr/share/doc/dockplane-agent" \
		"$root/DEBIAN"

	install -m 0755 "$binary" "$root/usr/bin/dockplane-agent"
	install -m 0644 agent/packaging/dockplane-agent.service \
		"$root/usr/lib/systemd/system/dockplane-agent.service"
	install -m 0644 agent/packaging/agent.env "$root/etc/dockplane-agent/agent.env"
	install -m 0644 agent/packaging/README.Debian \
		"$root/usr/share/doc/dockplane-agent/README.Debian"
	install -m 0644 agent/packaging/debian/copyright \
		"$root/usr/share/doc/dockplane-agent/copyright"

	# Marked as a configuration file so dpkg preserves an operator's edits
	# across an upgrade instead of overwriting them.
	echo "/etc/dockplane-agent/agent.env" > "$root/DEBIAN/conffiles"

	for script in postinst prerm postrm; do
		install -m 0755 "agent/packaging/debian/$script" "$root/DEBIAN/$script"
	done

	size="$(du -ks "$root" | cut -f1)"
	sed -e "s/@VERSION@/$DEBIAN_VERSION/" -e "s/@ARCH@/$arch/" -e "s/@SIZE@/$size/" \
		agent/packaging/debian/control.in > "$root/DEBIAN/control"
	sed -i.bak "s|^Maintainer:.*|Maintainer: $MAINTAINER|" "$root/DEBIAN/control"
	rm -f "$root/DEBIAN/control.bak"

	deb="$(agent_package_name "$VERSION" "$arch")"

	docker run --rm \
		-v "$OUT:/work" \
		-e SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
		-w /work \
		"$DEBIAN_IMAGE" \
		sh -c "chown -R root:root deb/$arch && dpkg-deb --root-owner-group --build deb/$arch /work/$deb" \
		> /dev/null

	echo "    $deb  $(du -h "$OUT/$deb" | cut -f1)"

	# --- the tarball ------------------------------------------------------
	stage="$OUT/tar/$(basename "$(agent_tarball_name "$VERSION" "$arch")" .tar.gz)"
	rm -rf "$stage"
	install -d -m 0755 "$stage"
	install -m 0755 "$binary" "$stage/dockplane-agent"
	install -m 0644 agent/packaging/dockplane-agent.service "$stage/dockplane-agent.service"
	install -m 0644 agent/packaging/agent.env "$stage/agent.env"
	install -m 0644 agent/packaging/README.tarball "$stage/README"
	install -m 0644 LICENSE "$stage/LICENSE"

	tarball="$(agent_tarball_name "$VERSION" "$arch")"

	# Packed in the same image that builds the package, for the same reason:
	# GNU tar sorts and stamps deterministically, and gzip -n leaves its own
	# timestamp out. A tar that quietly lacks those options produces an archive
	# that differs on every build, which is not something a checksum file
	# should be hiding.
	docker run --rm \
		-v "$OUT:/work" \
		-e SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
		-w /work \
		"$DEBIAN_IMAGE" \
		sh -c "tar --format=gnu --sort=name --owner=0 --group=0 --numeric-owner --no-xattrs \
			--mtime=@$SOURCE_DATE_EPOCH -C tar -cf - '$(basename "$stage")' \
			| gzip -n > '$tarball'" > /dev/null

	echo "    $tarball  $(du -h "$OUT/$tarball" | cut -f1)"
done

# --- checksums and manifest ---------------------------------------------
(cd "$OUT" && shasum -a 256 dockplane-agent_* > SHA256SUMS 2> /dev/null ||
	sha256sum dockplane-agent_* > SHA256SUMS)

# Verified rather than merely written: a checksum file nobody checks is a file
# that eventually stops matching.
(cd "$OUT" && (shasum -a 256 -c SHA256SUMS > /dev/null 2>&1 ||
	sha256sum -c SHA256SUMS > /dev/null)) && echo "==> checksums verified"

artefacts=""

for arch in $ARCHITECTURES; do
	for file in "$(agent_package_name "$VERSION" "$arch")" "$(agent_tarball_name "$VERSION" "$arch")"; do
		sum="$(grep -F "  $file" "$OUT/SHA256SUMS" | cut -d' ' -f1)"
		artefacts+="
    {
      \"name\": \"$file\",
      \"architecture\": \"$arch\",
      \"sha256\": \"$sum\"
    },"
	done
done

cat > "$OUT/release-manifest.json" <<JSON
{
  "component": "dockplane-agent",
  "version": "$VERSION",
  "license": "AGPL-3.0-only",
  "maintainer": "$MAINTAINER",
  "repository": "${DOCKPLANE_REPOSITORY:-https://github.com/Dockplanee/dockplane}",
  "agentVersion": "$VERSION",
  "debianVersion": "$DEBIAN_VERSION",
  "commit": "$COMMIT",
  "buildDate": "$BUILD_DATE",
  "protocolVersion": $PROTOCOL_VERSION,
  "artefacts": [${artefacts%,}
  ]
}
JSON

# Removed from inside a container: the package tree was chowned to root to build
# the .deb, and on Linux the invoking user cannot delete what root created. The
# artefacts themselves are handed back to whoever started this, so a second run
# can overwrite them.
docker run --rm \
	-v "$OUT:/work" \
	-w /work \
	"$DEBIAN_IMAGE" \
	sh -c "rm -rf build deb tar && chown -R $(id -u):$(id -g) ." > /dev/null

echo "==> manifest"
cat "$OUT/release-manifest.json"
