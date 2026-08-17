#!/usr/bin/env bash
#
# Scans the agent binaries a release publishes.
#
#   deploy/scan-agent.sh 0.1.0 [dist/agent] [dist/scan]
#
# The control-plane images are scanned from the registry after they are pushed.
# The agent is not an image: it ships as a native binary in a package and a
# tarball, and until 0.3.0 nothing scanned it. It is the artefact that runs on
# every managed host, so a release that says nothing about it says nothing about
# most of what it installs.
#
# The binary read here is the one that was published. It is taken out of the
# release tarball rather than built again, so the report and the artefact cannot
# describe different bytes.
#
# The scan tree holds that binary and nothing else. A report is evidence about
# an artefact, and a scan pointed at a build directory would carry whatever the
# build machine happened to have lying beside it.

set -euo pipefail

VERSION="${1:-}"
AGENT_DIR="${2:-dist/agent}"
OUT="${3:-dist/scan}"

if [[ -z "$VERSION" ]]; then
	echo "usage: $0 <version> [agent-directory] [output-directory]" >&2
	exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/release-assets.sh
source "$REPO_ROOT/deploy/release-assets.sh"

# The same scanner the images are scanned with, at the same pinned version.
# Two components assessed by two scanners are two answers that cannot be
# compared, and the release policy reads both.
TRIVY_IMAGE="${TRIVY_IMAGE:-aquasec/trivy:0.73.0}"
ARCHITECTURES="${ARCHITECTURES:-amd64 arm64}"

missing=()
for tool in docker jq tar; do
	command -v "$tool" > /dev/null || missing+=("$tool")
done

if [[ ${#missing[@]} -gt 0 ]]; then
	echo "missing on this machine: ${missing[*]}" >&2
	echo "The scanner runs in a container; these are what unpack and read its report." >&2
	exit 3
fi

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Shared with the image scan when there is one, so a release does not download
# the vulnerability database once per artefact.
CACHE="${TRIVY_CACHE:-$HOME/.cache/trivy}"
mkdir -p "$CACHE"

for arch in $ARCHITECTURES; do
	tarball="$AGENT_DIR/$(agent_tarball_name "$VERSION" "$arch")"

	if [[ ! -f "$tarball" ]]; then
		echo "no agent tarball for $arch: $tarball" >&2
		echo "Build the agent artefacts first: deploy/build-agent.sh $VERSION" >&2
		exit 4
	fi

	tree="$work/$arch"
	mkdir -p "$tree"
	tar xzf "$tarball" -C "$tree"

	report="$OUT/agent-linux-$arch.json"

	echo "==> dockplane-agent $VERSION ($arch)"

	docker run --rm \
		--volume "$tree:/scan:ro" \
		--volume "$CACHE:/root/.cache" \
		--volume "$OUT:/out" \
		"$TRIVY_IMAGE" rootfs \
		--severity CRITICAL,HIGH \
		--ignore-unfixed=false \
		--format json \
		--output "/out/$(basename "$report")" \
		--quiet \
		/scan

	# A scan that did not find the binary produces a report with no results,
	# which reads exactly like a binary with nothing wrong with it. The one
	# thing this file exists to produce is evidence, so it refuses to hand back
	# a report that never looked at anything.
	target="$(jq -r --arg arch "$arch" '
		[.Results[]? | select(.Class == "lang-pkgs" and .Type == "gobinary")
		 | select(.Target | contains("linux_" + $arch))
		 | .Target] | first // ""
	' "$report")"

	if [[ -z "$target" ]]; then
		echo "the $arch report describes no Go binary for that architecture" >&2
		echo "Trivy read $tree and found nothing it recognised as the agent." >&2
		exit 5
	fi

	printf '    %s\n' "$target"
done
