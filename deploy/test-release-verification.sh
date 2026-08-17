#!/usr/bin/env bash
#
# Checks the gate that stands between a built release and a published one.
#
#   deploy/test-release-verification.sh
#
# 0.1.0-rc.2 was published with an agent package under a name the installer
# never asks for. Nothing noticed, because nothing was looking at what GitHub
# had actually accepted. deploy/verify-release-assets.sh looks; these are the
# ways it has to say no.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY="$REPO_ROOT/deploy/verify-release-assets.sh"
VERSION=0.1.0-rc.3

# shellcheck source=deploy/release-assets.sh
source "$REPO_ROOT/deploy/release-assets.sh"

# The verifier reads the Version field out of the agent packages, so the ones
# here are real packages and reading them takes dpkg. Missing tools are refused
# rather than worked around: a run that quietly skipped that check would report
# a pass for the one thing this file exists to cover.
missing=()
for tool in jq dpkg-deb sha256sum; do
	command -v "$tool" > /dev/null || missing+=("$tool")
done

if [[ ${#missing[@]} -gt 0 ]]; then
	echo "these checks need: ${missing[*]}" >&2
	echo "run them on a Debian or Ubuntu machine, or in a container with dpkg." >&2
	exit 3
fi

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

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

ARCHITECTURES=(amd64 arm64)

# Two real packages, built once and copied into each scenario. Stand-in files
# named like packages would leave the verifier with nothing to read, and it
# would say so.
build_packages() {
	local into="$1" field="$2"
	mkdir -p "$into"

	local arch tree
	for arch in "${ARCHITECTURES[@]}"; do
		tree="$work/tree-$field-$arch"
		rm -rf "$tree"
		install -d -m 0755 "$tree/DEBIAN" "$tree/usr/bin"
		printf 'stands in for the agent\n' > "$tree/usr/bin/dockplane-agent"

		cat > "$tree/DEBIAN/control" <<-CONTROL
			Package: dockplane-agent
			Version: $field
			Architecture: $arch
			Maintainer: Dockplane <info@dockplane.de>
			Description: Fixture for the release verification checks.
		CONTROL

		dpkg-deb --root-owner-group --build "$tree" \
			"$into/$(agent_package_name "$VERSION" "$arch")" > /dev/null
	done
}

PACKAGES="$work/packages"
build_packages "$PACKAGES" "$(debian_version "$VERSION")"

# A stand-in for what deploy/scan-agent.sh produces, for one version and one
# architecture. Only the fields the verifier reads are filled in.
agent_report() {
	local version="$1" arch="$2"

	cat <<-REPORT
		{
		  "SchemaVersion": 2,
		  "ArtifactName": "/scan",
		  "ArtifactType": "filesystem",
		  "Trivy": { "Version": "0.73.0" },
		  "Results": [
		    {
		      "Target": "dockplane-agent_${version}_linux_${arch}/dockplane-agent",
		      "Class": "lang-pkgs",
		      "Type": "gobinary"
		    }
		  ]
		}
	REPORT
}

# A release exactly as it should be: built here, uploaded, fetched back.
# A second package directory builds an otherwise flawless release around
# packages that declare something else, so that check is tested on its own
# rather than alongside a checksum that no longer matches.
build_release() {
	local root="$1" packages="${2:-$PACKAGES}"

	rm -rf "$root"
	mkdir -p "$root/local" "$root/download"

	local name
	for name in $(release_asset_names "$VERSION" "${ARCHITECTURES[@]}"); do
		printf 'contents of %s\n' "$name" > "$root/local/$name"
	done

	local arch
	for arch in "${ARCHITECTURES[@]}"; do
		name="$(agent_package_name "$VERSION" "$arch")"
		cp "$packages/$name" "$root/local/$name"
	done

	printf '{\n  "version": "%s",\n  "commit": "%s",\n  "protocolVersion": 1,\n  "schemaVersion": "0005_host_setup",\n  "backupFormatVersion": 1,\n  "images": {\n    "controlServer": { "digest": "sha256:%s" },\n    "web": { "digest": "sha256:%s" }\n  },\n  "supplyChain": { "signature": "none" }\n}\n' \
		"$VERSION" "0123456789abcdef0123456789abcdef01234567" \
		"$(printf 'a%.0s' {1..64})" "$(printf 'b%.0s' {1..64})" > "$root/local/$(manifest_name)"

	printf 'sbom\n' > "$root/local/sbom-control-server-$VERSION.json"
	printf 'sbom\n' > "$root/local/sbom-web-$VERSION.json"
	printf 'prov\n' > "$root/local/provenance-control-server-$VERSION.json"
	printf 'prov\n' > "$root/local/provenance-web-$VERSION.json"
	printf 'trivy\n' > "$root/local/vulnerabilities-control-server-linux-amd64.json"

	# The agent reports are read rather than counted, so these are shaped like
	# what Trivy writes: a scanner version, and a Go binary target naming the
	# tarball the binary was taken out of.
	local arch
	for arch in "${ARCHITECTURES[@]}"; do
		agent_report "$VERSION" "$arch" > "$root/local/$(agent_report_name "$arch")"
	done

	(cd "$root/local" && sha256sum ./* > "$(checksums_name)" 2> /dev/null)
	# The checksum file names files the way a release does, without ./ prefixes.
	sed -i.bak 's| \./| |' "$root/local/$(checksums_name)" && rm -f "$root/local/$(checksums_name).bak"

	cp -R "$root/local/." "$root/download/"

	(cd "$root/local" && ls) | jq -R -s 'split("\n") | map(select(length > 0)) | map({name: .})' \
		> "$root/assets.json"
}

verify() {
	local root="$1"
	EXPECTED_COMMIT=0123456789abcdef0123456789abcdef01234567 \
		"$VERIFY" "$VERSION" "$root/local" "$root/assets.json" "$root/download" 2>&1
}

echo
echo "==> a release that is exactly right"

build_release "$work/good"
output="$(verify "$work/good")"
check "is accepted" "$(grep -qE '[0-9]+ passed, 0 failed' <<< "$output" && echo ok || echo fail)"
grep -q '0 failed' <<< "$output" || printf '%s\n' "$output" | grep '✗' | head -5 | sed 's/^/     /'

echo
echo "==> and every way it can be wrong is refused"

refuses() {
	local description="$1" name="$2" mutate="$3" packages="${4:-$PACKAGES}"
	local root="$work/$name"

	build_release "$root" "$packages"
	[[ -n "$mutate" ]] && ( cd "$root" && eval "$mutate" )

	local output
	output="$(verify "$root")"

	check "$description" "$(grep -qE '[0-9]+ passed, [1-9][0-9]* failed' <<< "$output" && echo ok || echo fail)"
}

# The RC.2 regression, exactly: GitHub reports a name nobody asked for.
refuses "a name GitHub rewrote" renamed \
	'jq "map(if .name == \"dockplane-agent_0.1.0-rc.3_amd64.deb\" then {name: \"dockplane-agent_0.1.0.rc.3_amd64.deb\"} else . end)" assets.json > a && mv a assets.json'

refuses "a name that still carries a tilde" tilde \
	'jq "map(if .name == \"dockplane-agent_0.1.0-rc.3_arm64.deb\" then {name: \"dockplane-agent_0.1.0~rc.3_arm64.deb\"} else . end)" assets.json > a && mv a assets.json'

refuses "an asset that never arrived" missing \
	'jq "map(select(.name != \"dockplane-agent_0.1.0-rc.3_amd64.deb\"))" assets.json > a && mv a assets.json'

refuses "an asset nobody meant to publish" unexpected \
	'jq ". + [{name: \"leftover.txt\"}]" assets.json > a && mv a assets.json'

refuses "the same asset twice" duplicate \
	'jq ". + [{name: \"SHA256SUMS\"}]" assets.json > a && mv a assets.json'

refuses "an asset that came back different" altered \
	'printf "tampered\n" > download/dockplane-agent_0.1.0-rc.3_amd64.deb'

refuses "an asset that could not be fetched back" unfetchable \
	'rm -f download/dockplane-0.1.0-rc.3.tar.gz'

refuses "published checksums that do not match the published files" bad-sums \
	'printf "0000000000000000000000000000000000000000000000000000000000000000  dockplane-agent_0.1.0-rc.3_amd64.deb\n" > download/SHA256SUMS'

# Correctly named, correctly checksummed, and wrong where only dpkg looks.
build_packages "$work/packages-wrong-field" 0.9.9
refuses "a package that declares a version it was not named for" wrong-field \
	'' "$work/packages-wrong-field"

refuses "a manifest for another version" wrong-version \
	'jq ".version = \"0.9.9\"" download/release-manifest.json > a && mv a download/release-manifest.json'

refuses "a manifest built from another commit" wrong-commit \
	'jq ".commit = \"ffffffffffffffffffffffffffffffffffffffff\"" download/release-manifest.json > a && mv a download/release-manifest.json'

refuses "a manifest that claims a signature it does not have" claims-signature \
	'jq ".supplyChain.signature = \"cosign\"" download/release-manifest.json > a && mv a download/release-manifest.json'

refuses "a manifest missing an interface version" no-schema \
	'jq "del(.schemaVersion)" download/release-manifest.json > a && mv a download/release-manifest.json'

refuses "a manifest with no image digests" no-digests \
	'jq "del(.images)" download/release-manifest.json > a && mv a download/release-manifest.json'

# A build that could not read a digest once wrote a word there instead. It is
# as present as a real one, and pins nothing.
refuses "a manifest with a placeholder where a digest belongs" placeholder-digest \
	'jq ".images.controlServer.digest = \"unknown\"" download/release-manifest.json > a && mv a download/release-manifest.json'

refuses "a manifest with a digest that is not a digest" short-digest \
	'jq ".images.web.digest = \"sha256:abc\"" download/release-manifest.json > a && mv a download/release-manifest.json'

# The agent runs on every managed host and was the one published artefact
# nothing scanned. These are the ways that can go wrong again.
refuses "an agent report that was never produced for amd64" no-agent-report-amd64 \
	'rm -f local/vulnerabilities-agent-linux-amd64.json download/vulnerabilities-agent-linux-amd64.json
	 jq "map(select(.name != \"vulnerabilities-agent-linux-amd64.json\"))" assets.json > a && mv a assets.json'

refuses "an agent report that was never produced for arm64" no-agent-report-arm64 \
	'rm -f local/vulnerabilities-agent-linux-arm64.json download/vulnerabilities-agent-linux-arm64.json
	 jq "map(select(.name != \"vulnerabilities-agent-linux-arm64.json\"))" assets.json > a && mv a assets.json'

refuses "an agent report that came back different" altered-agent-report \
	'printf "tampered\n" > download/vulnerabilities-agent-linux-amd64.json'

refuses "an agent report the checksums do not cover" unchecksummed-agent-report \
	'grep -v "vulnerabilities-agent-linux-amd64.json" download/SHA256SUMS > a && mv a download/SHA256SUMS
	 printf "tampered\n" > download/vulnerabilities-agent-linux-amd64.json'

# Correctly named, correctly checksummed, and produced from the wrong artefact.
refuses "an agent report produced for another architecture" crossed-agent-report \
	'sed "s/linux_arm64/linux_amd64/" local/vulnerabilities-agent-linux-arm64.json > a
	 mv a local/vulnerabilities-agent-linux-arm64.json
	 cp local/vulnerabilities-agent-linux-arm64.json download/
	 (cd local && sha256sum ./* > SHA256SUMS 2>/dev/null; sed -i.bak "s| \./| |" SHA256SUMS; rm -f SHA256SUMS.bak)
	 cp local/SHA256SUMS download/SHA256SUMS'

refuses "an agent report produced for another version" stale-agent-report \
	'sed "s/dockplane-agent_0.1.0-rc.3_linux_amd64/dockplane-agent_0.9.9_linux_amd64/" \
	     local/vulnerabilities-agent-linux-amd64.json > a
	 mv a local/vulnerabilities-agent-linux-amd64.json
	 cp local/vulnerabilities-agent-linux-amd64.json download/
	 (cd local && sha256sum ./* > SHA256SUMS 2>/dev/null; sed -i.bak "s| \./| |" SHA256SUMS; rm -f SHA256SUMS.bak)
	 cp local/SHA256SUMS download/SHA256SUMS'

refuses "an agent report that is not a scanner report" unreadable-agent-report \
	'printf "not json\n" > local/vulnerabilities-agent-linux-amd64.json
	 cp local/vulnerabilities-agent-linux-amd64.json download/
	 (cd local && sha256sum ./* > SHA256SUMS 2>/dev/null; sed -i.bak "s| \./| |" SHA256SUMS; rm -f SHA256SUMS.bak)
	 cp local/SHA256SUMS download/SHA256SUMS'

echo
if [[ "$failed" -eq 0 ]]; then
	printf '%s%d passed, 0 failed%s\n' "$GREEN" "$passed" "$RESET"
else
	printf '%s%d passed, %d failed%s\n' "$RED" "$passed" "$failed" "$RESET"
fi

[[ "$failed" -eq 0 ]]
