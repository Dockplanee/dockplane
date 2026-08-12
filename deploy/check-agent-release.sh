#!/usr/bin/env bash
#
# Checks the agent release artefacts before anyone installs them.
#
#   deploy/check-agent-release.sh 0.1.0 [dist/agent]
#
# Everything here is a property that would be expensive to discover on a real
# host: a package carrying an identity, a binary that cannot say what it is, a
# unit that was left out, a checksum nobody verified.

set -euo pipefail

VERSION="${1:-}"
OUT="${2:-dist/agent}"

# A pre-release is named with a tilde in a Debian package, because that is what
# dpkg reads as "earlier than the release".
# shellcheck source=deploy/release-assets.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-assets.sh"

DEBIAN_VERSION="$(debian_version "$VERSION")"

if [[ -z "$VERSION" ]]; then
	echo "usage: $0 <version> [directory]" >&2
	exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DEBIAN_IMAGE="${DEBIAN_IMAGE:-debian:12-slim}"
ARCHITECTURES="${ARCHITECTURES:-amd64 arm64}"

# Named rather than assumed. Everything else here runs in a pinned container;
# file(1) is the one thing read from the host, and a checker that dies with
# "command not found" halfway through says nothing useful about the release.
missing=()
for tool in docker file strings dpkg-deb sha256sum tar; do
	command -v "$tool" > /dev/null || missing+=("$tool")
done

if [[ ${#missing[@]} -gt 0 ]]; then
	echo "missing on this machine: ${missing[*]}" >&2
	exit 3
fi

failures=0
checks=0

check() {
	checks=$((checks + 1))

	if [[ "$1" == "ok" ]]; then
		printf '  ok    %s\n' "$2"
	else
		printf '  FAIL  %s\n' "$2"
		failures=$((failures + 1))
	fi
}

expect_contains() {
	local haystack="$1" needle="$2" description="$3"
	[[ "$haystack" == *"$needle"* ]] && check ok "$description" || check fail "$description"
}

expect_absent() {
	local haystack="$1" needle="$2" description="$3"
	[[ "$haystack" != *"$needle"* ]] && check ok "$description" || check fail "$description"
}

echo "==> artefacts for $VERSION in $OUT"

for arch in $ARCHITECTURES; do
	for file in "$(agent_package_name "$VERSION" "$arch")" \
		"$(agent_tarball_name "$VERSION" "$arch")"; do
		[[ -f "$OUT/$file" ]] && check ok "$file exists" || check fail "$file exists"
	done
done

[[ -f "$OUT/SHA256SUMS" ]] && check ok "SHA256SUMS exists" || check fail "SHA256SUMS exists"
[[ -f "$OUT/release-manifest.json" ]] && check ok "release-manifest.json exists" ||
	check fail "release-manifest.json exists"

echo "==> checksums"
if (cd "$OUT" && (shasum -a 256 -c SHA256SUMS > /dev/null 2>&1 || sha256sum -c SHA256SUMS > /dev/null 2>&1)); then
	check ok "every artefact matches its recorded checksum"
else
	check fail "every artefact matches its recorded checksum"
fi

echo "==> the manifest describes what is here"
manifest="$(cat "$OUT/release-manifest.json")"
expect_contains "$manifest" "\"version\": \"$VERSION\"" "manifest names the version"
expect_contains "$manifest" '"protocolVersion"' "manifest records the protocol version"
expect_absent "$manifest" "dev" "manifest carries no development marker"

for arch in $ARCHITECTURES; do
	echo "==> $arch package"

	contents="$(docker run --rm -v "$REPO_ROOT/$OUT:/w:ro" -w /w "$DEBIAN_IMAGE" \
		dpkg-deb --contents "$(agent_package_name "$VERSION" "$arch")")"
	control="$(docker run --rm -v "$REPO_ROOT/$OUT:/w:ro" -w /w "$DEBIAN_IMAGE" \
		dpkg-deb --field "$(agent_package_name "$VERSION" "$arch")")"

	expect_contains "$control" "Architecture: $arch" "declares architecture $arch"
	expect_contains "$control" "Version: $DEBIAN_VERSION" "declares version $DEBIAN_VERSION"
	expect_contains "$control" "Maintainer:" "names a maintainer"
	expect_contains "$control" "Homepage:" "names a homepage"

	expect_contains "$contents" "./usr/bin/dockplane-agent" "ships the binary"
	expect_contains "$contents" "./usr/lib/systemd/system/dockplane-agent.service" "ships the unit"
	expect_contains "$contents" "./etc/dockplane-agent/agent.env" "ships the settings file"

	# The identity is created on the host by enrolling. A package that carried
	# one would give every installation the same identity.
	expect_absent "$contents" "agent.key" "carries no private key"
	expect_absent "$contents" "agent.crt" "carries no certificate"
	expect_absent "$contents" "identity.json" "carries no identity"
	expect_absent "$contents" "/var/lib/dockplane-agent/" "creates no state directory of its own"

	# Extracted, so the checks below are about the binary rather than the
	# package that happens to contain it.
	work="$(mktemp -d)"
	# Handed back to whoever started this. dpkg-deb restores the package's own
	# ownership, which is root, and on Linux the invoking user can then neither
	# read the tree nor delete it afterwards.
	docker run --rm -v "$REPO_ROOT/$OUT:/w:ro" -v "$work:/x" -w /w "$DEBIAN_IMAGE" \
		sh -c "dpkg-deb --extract '$(agent_package_name "$VERSION" "$arch")' /x &&
			chown -R $(id -u):$(id -g) /x"

	described="$(file -b "$work/usr/bin/dockplane-agent")"
	expect_contains "$described" "ELF 64-bit" "binary is a 64-bit ELF executable"
	expect_contains "$described" "statically linked" "binary is statically linked"

	case "$arch" in
		amd64) expect_contains "$described" "x86-64" "binary is x86-64" ;;
		arm64) expect_contains "$described" "aarch64" "binary is aarch64" ;;
	esac

	# Only the native architecture can be run here, and only that one can be
	# asked what it is.
	if [[ "$arch" == "$(dpkg --print-architecture 2> /dev/null || uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" ]]; then
		reported="$(docker run --rm -v "$work/usr/bin:/b:ro" "$DEBIAN_IMAGE" /b/dockplane-agent version)"
		expect_contains "$reported" "$VERSION" "version command reports $VERSION"
		expect_contains "$reported" "protocol v" "version command reports the protocol version"
		expect_contains "$reported" "commit " "version command reports the commit"
		expect_contains "$reported" "built " "version command reports the build date"
		expect_absent "$reported" "0.0.0-dev" "version command reports no development version"
	fi

	# A release binary that carried a token, a key or a hardcoded server would
	# be a supply chain problem rather than a packaging one.
	strung="$(strings -a "$work/usr/bin/dockplane-agent" 2> /dev/null | grep -icE \
		'BEGIN [A-Z ]*PRIVATE KEY|dockplane-enroll-[A-Za-z0-9]{8}|password=' || true)"
	[[ "$strung" == "0" ]] && check ok "binary embeds no key, token or password" ||
		check fail "binary embeds no key, token or password"

	rm -rf "$work"

	echo "==> $arch tarball"
	listing="$(tar -tzf "$OUT/dockplane-agent_${VERSION}_linux_${arch}.tar.gz")"
	expect_contains "$listing" "dockplane-agent" "ships the binary"
	expect_contains "$listing" "dockplane-agent.service" "ships the unit"
	expect_contains "$listing" "README" "ships installation notes"
	expect_absent "$listing" "agent.key" "carries no private key"
	expect_absent "$listing" "identity.json" "carries no identity"
done

echo
echo "$((checks - failures))/$checks checks passed"
exit $((failures > 0 ? 1 : 0))
