#!/usr/bin/env bash
#
# Builds a release twice, independently, and compares what came out.
#
#   deploy/check-reproducible-build.sh 0.2.0-rc.4
#
# The release promises that the same commit produces the same images and the
# same agent artefacts. 0.2.0-rc.3 was hardened with two builds that agreed and
# published images that did not match either of them: both builds had used the
# same buildx builder, so the second one read the first one's layers out of the
# cache and agreed with itself. A comparison that a cache can satisfy is not a
# comparison.
#
# So this refuses to reuse anything. Each build gets a builder created here and
# destroyed afterwards, which is a container with its own BuildKit state, and
# the second build reads a tree exported from git rather than the working copy.
# Nothing is passed between them except the commit.
#
# The report it writes names every artefact and its digest, so two machines can
# be compared by diffing two reports.

set -uo pipefail

VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
	echo "usage: $0 <version>" >&2
	exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
WORK="${WORK:-$REPO_ROOT/dist/reproducibility}"
REPORT="$WORK/reproducibility-report.txt"

if [[ -t 1 ]]; then
	RED=$'\033[31m' GREEN=$'\033[32m' RESET=$'\033[0m'
else
	RED='' GREEN='' RESET=''
fi

passed=0
failed=0

check() {
	local condition="$1" description="$2"

	if [[ "$condition" == "ok" ]]; then
		printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$description"
		passed=$((passed + 1))
	else
		printf '  %s✗%s %s\n' "$RED" "$RESET" "$description"
		failed=$((failed + 1))
	fi
}

for tool in docker git jq tar; do
	command -v "$tool" > /dev/null || {
		echo "missing on this machine: $tool" >&2
		exit 3
	}
done

COMMIT="$(git rev-parse HEAD)"
EPOCH="$(git log -1 --pretty=%ct)"

if [[ -n "$(git status --porcelain)" ]]; then
	echo "the working tree has changes: build a commit, not a draft" >&2
	exit 4
fi

# --- the builds cannot be allowed to share anything -------------------------
#
# A name each, created here, so neither can be an existing builder that already
# holds layers of this commit. BUILDX_BUILDER would override both silently.
BUILDER_A="dockplane-repro-a-${COMMIT:0:7}"
BUILDER_B="dockplane-repro-b-${COMMIT:0:7}"

if [[ "$BUILDER_A" == "$BUILDER_B" ]]; then
	echo "the two builds would share a builder" >&2
	exit 4
fi

unset BUILDX_BUILDER

cleanup() {
	docker buildx rm --force "$BUILDER_A" > /dev/null 2>&1
	docker buildx rm --force "$BUILDER_B" > /dev/null 2>&1
}
trap cleanup EXIT

rm -rf "$WORK"
mkdir -p "$WORK/a" "$WORK/b" "$WORK/src-b"

echo
echo "reproducing $VERSION at $COMMIT"
echo "  platforms: $PLATFORMS"

build() {
	local builder="$1" source_dir="$2" out="$3" label="$4"

	docker buildx rm --force "$builder" > /dev/null 2>&1
	docker buildx create --name "$builder" --driver docker-container > /dev/null

	echo
	echo "==> build $label  (builder $builder, no cache of its own to reuse)"

	(
		cd "$source_dir" || exit 1
		OUT="$out" \
			BUILDX_BUILDER="$builder" \
			PLATFORMS="$PLATFORMS" \
			PUSH=0 SBOM=0 \
			SOURCE_DATE_EPOCH="$EPOCH" \
			DOCKPLANE_COMMIT="$COMMIT" \
			deploy/build-images.sh "$VERSION" > "$out/build.log" 2>&1
	) || {
		echo "build $label failed; see $out/build.log" >&2
		return 1
	}

	(
		cd "$source_dir" || exit 1
		OUT="$out/agent" \
			SOURCE_DATE_EPOCH="$EPOCH" \
			DOCKPLANE_COMMIT="$COMMIT" \
			deploy/build-agent.sh "$VERSION" > "$out/agent.log" 2>&1
	) || {
		echo "agent build $label failed; see $out/agent.log" >&2
		return 1
	}
}

# The second build reads an export of the commit rather than the working copy,
# so a file that is present but untracked cannot reach it.
git archive "$COMMIT" | tar -x -C "$WORK/src-b"

build "$BUILDER_A" "$REPO_ROOT" "$WORK/a" A || exit 5
build "$BUILDER_B" "$WORK/src-b" "$WORK/b" B || exit 5

# --- what each build produced -----------------------------------------------
platform_digests() {
	local archive="$1" layout
	layout="$(mktemp -d)"

	tar -xf "$archive" -C "$layout"
	local index
	index="$(jq -r '.manifests[0].digest' "$layout/index.json" | sed 's/sha256://')"

	jq -r '.manifests[]
		| select(.platform.architecture != "unknown")
		| "\(.platform.os)/\(.platform.architecture) \(.digest)"' \
		"$layout/blobs/sha256/$index" | sort

	rm -rf "$layout"
}

attestation_digests() {
	local archive="$1" layout
	layout="$(mktemp -d)"

	tar -xf "$archive" -C "$layout"
	local index
	index="$(jq -r '.manifests[0].digest' "$layout/index.json" | sed 's/sha256://')"

	jq -r '.manifests[]
		| select(.platform.architecture == "unknown")
		| .digest' "$layout/blobs/sha256/$index" | sort

	rm -rf "$layout"
}

{
	echo "commit $COMMIT"
	echo "version $VERSION"
	echo "platforms $PLATFORMS"
} > "$REPORT"

echo
echo "images"

for image in control-server web; do
	archive="$image-$VERSION.oci.tar"

	a="$(platform_digests "$WORK/a/$archive")"
	b="$(platform_digests "$WORK/b/$archive")"

	while read -r platform digest; do
		[[ -n "$platform" ]] || continue
		echo "image $image $platform $digest" >> "$REPORT"
	done <<< "$a"

	if [[ "$a" == "$b" ]]; then
		check ok "$image: both platform images identical"
	else
		check fail "$image: a platform image differs"
		diff <(echo "$a") <(echo "$b") | sed 's/^/      /'
	fi
done

echo
echo "agent artefacts"

for name in \
	"dockplane-agent_${VERSION}_amd64.deb" \
	"dockplane-agent_${VERSION}_arm64.deb" \
	"dockplane-agent_${VERSION}_linux_amd64.tar.gz" \
	"dockplane-agent_${VERSION}_linux_arm64.tar.gz"; do

	a="$(sha256sum "$WORK/a/agent/$name" 2> /dev/null | cut -d' ' -f1)"
	b="$(sha256sum "$WORK/b/agent/$name" 2> /dev/null | cut -d' ' -f1)"

	echo "agent $name $a" >> "$REPORT"

	if [[ -n "$a" && "$a" == "$b" ]]; then
		check ok "$name identical"
	else
		check fail "$name differs"
	fi
done

# The binary itself, read out of the artefact that ships it: the build removes
# its staging directories, and a comparison of two files that are both absent
# passes without comparing anything.
binary_checksum() {
	local tarball="$1" unpacked binary
	unpacked="$(mktemp -d)"

	tar -xzf "$tarball" -C "$unpacked" 2> /dev/null
	binary="$(find "$unpacked" -type f -name dockplane-agent | head -1)"

	[[ -n "$binary" ]] && sha256sum "$binary" | cut -d' ' -f1

	rm -rf "$unpacked"
}

for arch in amd64 arm64; do
	tarball="agent/dockplane-agent_${VERSION}_linux_${arch}.tar.gz"

	a="$(binary_checksum "$WORK/a/$tarball")"
	b="$(binary_checksum "$WORK/b/$tarball")"

	echo "agent binary $arch $a" >> "$REPORT"

	if [[ -n "$a" && "$a" == "$b" ]]; then
		check ok "agent binary $arch identical"
	else
		check fail "agent binary $arch differs or was not found"
	fi
done

# --- what is allowed to differ ----------------------------------------------
#
# A provenance attestation records a build: when it ran and where. Two builds of
# one commit describe two events, so these are expected to differ and are
# reported rather than compared. Nothing else is given that latitude.
echo
echo "attestations (expected to differ, recorded not compared)"

for image in control-server web; do
	archive="$image-$VERSION.oci.tar"
	a="$(attestation_digests "$WORK/a/$archive" | tr '\n' ' ')"
	b="$(attestation_digests "$WORK/b/$archive" | tr '\n' ' ')"

	if [[ -z "$a" && -z "$b" ]]; then
		echo "  $image: none in this build"
	elif [[ "$a" == "$b" ]]; then
		echo "  $image: identical"
	else
		echo "  $image: differ, as a record of two builds does"
	fi
done

echo
echo "report: $REPORT"
echo

if [[ $failed -eq 0 ]]; then
	echo "$passed/$((passed + failed)) reproducible"
	exit 0
fi

echo "$failed of $((passed + failed)) artefacts are not reproducible" >&2
exit 1
