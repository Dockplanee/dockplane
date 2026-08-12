#!/usr/bin/env bash
#
# Checks that a GitHub release holds exactly what was built, under exactly the
# names it was built under.
#
#   deploy/verify-release-assets.sh <version> <local-directory> <assets.json> [downloads]
#
# 0.1.0-rc.2 published dockplane-agent_0.1.0.rc.2_amd64.deb while the installer
# asked for dockplane-agent_0.1.0~rc.2_amd64.deb: GitHub rewrites characters it
# does not accept in an asset name, and the download 404'd for everybody. The
# names are correct now, but nothing was checking — so this does.
#
#   assets.json   what GitHub reports the release holds, from the releases API
#   downloads     those assets fetched back from GitHub, if the caller has them
#
# With a download directory this is a full round trip: built here, uploaded,
# fetched back, and the checksums compared at both ends. Without one it still
# refuses a release whose asset list is not what was meant to be published.

set -uo pipefail

VERSION="${1:-}"
LOCAL_DIR="${2:-}"
ASSET_LIST="${3:-}"
DOWNLOAD_DIR="${4:-}"

if [[ -z "$VERSION" || -z "$LOCAL_DIR" || -z "$ASSET_LIST" ]]; then
	echo "usage: $0 <version> <local-directory> <assets.json> [downloads]" >&2
	exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/release-assets.sh
source "$REPO_ROOT/deploy/release-assets.sh"

command -v jq > /dev/null || {
	echo "jq is required to read the release's asset list" >&2
	exit 3
}

if [[ -t 1 ]]; then
	RED=$'\033[31m' GREEN=$'\033[32m' RESET=$'\033[0m'
else
	RED='' GREEN='' RESET=''
fi

passed=0
failed=0

check() {
	local description="$1" condition="$2"

	if [[ "$condition" == "ok" ]]; then
		printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$description"
		passed=$((passed + 1))
	else
		printf '  %s✗%s %s\n' "$RED" "$RESET" "$description"
		failed=$((failed + 1))
	fi
}

ARCHITECTURES=(amd64 arm64)

# What was meant to be published, from the one place that names these files.
expected=()
while IFS= read -r name; do
	[[ -n "$name" ]] && expected+=("$name")
done < <(release_asset_names "$VERSION" "${ARCHITECTURES[@]}")

expected+=("$(checksums_name)" "$(manifest_name)")

# The supply-chain documents are named by the build rather than by version
# alone, so they are taken from what is actually on disk.
while IFS= read -r name; do
	[[ -n "$name" ]] && expected+=("$name")
done < <(cd "$LOCAL_DIR" 2> /dev/null && ls sbom-*.json provenance-*.json vulnerabilities-*.json 2> /dev/null)

echo
echo "==> what the release should hold"

uploaded=()
while IFS= read -r name; do
	[[ -n "$name" ]] && uploaded+=("$name")
done < <(jq -r '.[].name' "$ASSET_LIST" 2> /dev/null)

check "the release reports assets at all" "$([[ ${#uploaded[@]} -gt 0 ]] && echo ok || echo fail)"
printf '     expected %d, GitHub reports %d\n' "${#expected[@]}" "${#uploaded[@]}"

missing=()
for name in "${expected[@]}"; do
	printf '%s\n' "${uploaded[@]}" | grep -qxF "$name" || missing+=("$name")
done

check "every expected asset is there" "$([[ ${#missing[@]} -eq 0 ]] && echo ok || echo fail)"
[[ ${#missing[@]} -gt 0 ]] && printf '     missing: %s\n' "${missing[*]}"

unexpected=()
for name in "${uploaded[@]}"; do
	printf '%s\n' "${expected[@]}" | grep -qxF "$name" || unexpected+=("$name")
done

check "nothing unexpected is there" "$([[ ${#unexpected[@]} -eq 0 ]] && echo ok || echo fail)"
[[ ${#unexpected[@]} -gt 0 ]] && printf '     unexpected: %s\n' "${unexpected[*]}"

duplicates="$(printf '%s\n' "${uploaded[@]}" | sort | uniq -d)"
check "no asset appears twice" "$([[ -z "$duplicates" ]] && echo ok || echo fail)"
[[ -n "$duplicates" ]] && printf '     duplicated: %s\n' "$duplicates"

# The regression itself. A name GitHub rewrote is a file published under one
# name and fetched under another.
rewritten=()
for name in "${uploaded[@]}"; do
	assert_publishable "$name" 2> /dev/null || rewritten+=("$name")
	[[ "$name" == *"~"* ]] && rewritten+=("$name")
done

check "no name was rewritten on the way up" "$([[ ${#rewritten[@]} -eq 0 ]] && echo ok || echo fail)"
[[ ${#rewritten[@]} -gt 0 ]] && printf '     rewritten: %s\n' "${rewritten[*]}"

# The installer asks for these by name. If they are not there under exactly
# this name, adding a host from the release fails on a 404.
for arch in "${ARCHITECTURES[@]}"; do
	name="$(agent_package_name "$VERSION" "$arch")"
	check "the installer's $arch package is published as $name" \
		"$(printf '%s\n' "${uploaded[@]}" | grep -qxF "$name" && echo ok || echo fail)"
done

# GitHub reports a digest for an asset where it can. It is a second opinion,
# not the round trip.
if jq -e '.[0] | has("digest")' "$ASSET_LIST" > /dev/null 2>&1; then
	mismatched=()

	while IFS=$'\t' read -r name digest; do
		[[ -n "$digest" && "$digest" != "null" ]] || continue
		[[ -f "$LOCAL_DIR/$name" ]] || continue

		local_sum="sha256:$(sha256sum "$LOCAL_DIR/$name" | cut -d' ' -f1)"
		[[ "$digest" == "$local_sum" ]] || mismatched+=("$name")
	done < <(jq -r '.[] | [.name, (.digest // "")] | @tsv' "$ASSET_LIST")

	check "the digests GitHub reports match what was built" \
		"$([[ ${#mismatched[@]} -eq 0 ]] && echo ok || echo fail)"
	[[ ${#mismatched[@]} -gt 0 ]] && printf '     differ: %s\n' "${mismatched[*]}"
fi

if [[ -z "$DOWNLOAD_DIR" ]]; then
	echo
	echo "  no downloads given; the round trip was not checked"
else
	echo
	echo "==> and that what comes back is what went up"

	differing=()
	absent=()

	for name in "${expected[@]}"; do
		if [[ ! -f "$DOWNLOAD_DIR/$name" ]]; then
			absent+=("$name")
			continue
		fi

		[[ -f "$LOCAL_DIR/$name" ]] || continue

		if [[ "$(sha256sum "$DOWNLOAD_DIR/$name" | cut -d' ' -f1)" != \
			"$(sha256sum "$LOCAL_DIR/$name" | cut -d' ' -f1)" ]]; then
			differing+=("$name")
		fi
	done

	check "every asset could be fetched back" "$([[ ${#absent[@]} -eq 0 ]] && echo ok || echo fail)"
	[[ ${#absent[@]} -gt 0 ]] && printf '     could not be fetched: %s\n' "${absent[*]}"

	check "what came back is byte for byte what was built" \
		"$([[ ${#differing[@]} -eq 0 ]] && echo ok || echo fail)"
	[[ ${#differing[@]} -gt 0 ]] && printf '     differ: %s\n' "${differing[*]}"

	# The checksum file from GitHub, against the files from GitHub. Nothing
	# local takes part: this is what somebody downloading the release does.
	if [[ -f "$DOWNLOAD_DIR/$(checksums_name)" ]]; then
		if (cd "$DOWNLOAD_DIR" && sha256sum --quiet -c "$(checksums_name)" > /dev/null 2>&1); then
			check "the published checksums verify the published files" ok
		else
			check "the published checksums verify the published files" fail
			(cd "$DOWNLOAD_DIR" && sha256sum -c "$(checksums_name)" 2>&1 | grep -v ': OK$' | head -5 |
				sed 's/^/     /')
		fi
	else
		check "the published checksums verify the published files" fail
	fi

	# A package is two versions: the one it is called and the one dpkg orders by.
	for arch in "${ARCHITECTURES[@]}"; do
		package="$DOWNLOAD_DIR/$(agent_package_name "$VERSION" "$arch")"

		if [[ -f "$package" ]] && command -v dpkg-deb > /dev/null; then
			field="$(dpkg-deb -f "$package" Version 2> /dev/null || true)"
			check "the $arch package declares version $(debian_version "$VERSION")" \
				"$([[ "$field" == "$(debian_version "$VERSION")" ]] && echo ok || echo fail)"
			[[ "$field" != "$(debian_version "$VERSION")" ]] && printf '     declares: %s\n' "$field"
		fi
	done

	# The manifest describes this release and no other.
	manifest="$DOWNLOAD_DIR/$(manifest_name)"

	if [[ -f "$manifest" ]]; then
		check "the manifest names this version" \
			"$([[ "$(jq -r .version "$manifest")" == "$VERSION" ]] && echo ok || echo fail)"
		check "the manifest names the commit it was built from" \
			"$([[ "$(jq -r .commit "$manifest")" =~ ^[0-9a-f]{40}$ ]] && echo ok || echo fail)"

		if [[ -n "${EXPECTED_COMMIT:-}" ]]; then
			check "the manifest's commit is the tagged one" \
				"$([[ "$(jq -r .commit "$manifest")" == "$EXPECTED_COMMIT" ]] && echo ok || echo fail)"
		fi

		for field in protocolVersion schemaVersion backupFormatVersion; do
			check "the manifest records the $field" \
				"$(jq -e "has(\"$field\")" "$manifest" > /dev/null && echo ok || echo fail)"
		done

		check "the manifest names the images it published" \
			"$(jq -e '.images.controlServer.digest and .images.web.digest' "$manifest" > /dev/null &&
				echo ok || echo fail)"
		check "the manifest states what it does and does not carry" \
			"$([[ "$(jq -r .supplyChain.signature "$manifest")" == "none" ]] && echo ok || echo fail)"
	else
		check "the manifest came back" fail
	fi
fi

echo
if [[ "$failed" -eq 0 ]]; then
	printf '%s%d passed, 0 failed%s\n' "$GREEN" "$passed" "$RESET"
else
	printf '%s%d passed, %d failed%s\n' "$RED" "$passed" "$failed" "$RESET"
fi

[[ "$failed" -eq 0 ]]
