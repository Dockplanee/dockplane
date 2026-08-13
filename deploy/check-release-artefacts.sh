#!/usr/bin/env bash
#
# Checks the control-plane release artefacts before anyone installs them.
#
#   deploy/check-release-artefacts.sh 0.1.0 [dist/release]
#
# The agent packages have their own checker; this is the other half of a
# release: the bundle an operator unpacks as root, and the images that bundle
# installs. Everything here is a property that is cheap to check now and
# expensive to discover afterwards — a bundle carrying somebody's notes, an
# image running as root, a layer that remembers a secret it was built with.

set -euo pipefail

VERSION="${1:-}"
OUT="${2:-dist/release}"

if [[ -z "$VERSION" ]]; then
	echo "usage: $0 <version> [directory]" >&2
	exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=deploy/release-assets.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-assets.sh"

# Named rather than assumed. A checker that dies with "command not found"
# halfway through says nothing useful about the release.
missing=()
for tool in docker jq sha256sum tar; do
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

expect_equal() {
	local actual="$1" expected="$2" description="$3"

	if [[ "$actual" == "$expected" ]]; then
		check ok "$description"
	else
		check fail "$description"
		printf '        expected %s, got %s\n' "$expected" "$actual"
	fi
}

BUNDLE="$OUT/$(bundle_name "$VERSION")"
MANIFEST="$OUT/release-manifest.json"

for required in "$BUNDLE" "$MANIFEST"; do
	if [[ ! -f "$required" ]]; then
		echo "no such file: $required" >&2
		echo "Build the release first: deploy/build-images.sh $VERSION" >&2
		exit 4
	fi
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

tar -xzf "$BUNDLE" -C "$work"
ROOT="$work/dockplane-$VERSION"

echo "==> the release manifest"

expect_equal "$(jq -r .version "$MANIFEST")" "$VERSION" "names the version being built"
expect_equal "$(jq -r .license "$MANIFEST")" "AGPL-3.0-only" "names the licence"

commit="$(jq -r .commit "$MANIFEST")"

# A release built from a tree with uncommitted changes cannot be rebuilt from
# anything. The build marks it, and this is where that mark stops a release.
if [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
	check ok "names the commit it was built from"
else
	check fail "names the commit it was built from"
	printf '        %s\n' "$commit"
fi

for field in protocolVersion schemaVersion backupFormatVersion; do
	value="$(jq -r ".$field" "$MANIFEST")"

	if [[ -n "$value" && "$value" != "null" ]]; then
		check ok "declares $field"
	else
		check fail "declares $field"
	fi
done

# The three frozen interfaces are what makes one release compatible with
# another, and the manifest is where an operator reads them.
expect_equal "$(jq -r .schemaVersion "$MANIFEST")" \
	"$(jq -r '.entries[-1].tag' api/src/database/migrations/meta/_journal.json)" \
	"declares the schema this build carries"

for image in controlServer web; do
	digest="$(jq -r ".images.$image.digest" "$MANIFEST")"

	if [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
		check ok "names what it published for $image"
	else
		check fail "names what it published for $image"
	fi
done

echo
echo "==> what the bundle holds"

# Exactly this, and nothing else. A bundle is unpacked and run as root, so
# every file in it is a file somebody has to have decided to ship.
expected="$(
	cat <<-'FILES'
		LICENSE
		README
		backup-restore.sh
		compose/.env.example
		compose/Caddyfile
		compose/compose.yaml
		dockplane-control
		install-control-plane.sh
		release-manifest.json
	FILES
)"

# The images directory is there when the bundle installs offline.
actual="$(cd "$ROOT" && find . -type f ! -path './images/*' | sed 's|^\./||' | sort)"

expect_equal "$actual" "$expected" "holds exactly the files a deployment needs"

check "$([[ -x "$ROOT/install-control-plane.sh" ]] && echo ok || echo fail)" \
	"the installer is executable"
check "$([[ -x "$ROOT/dockplane-control" ]] && echo ok || echo fail)" \
	"the operations command is executable"

writable="$(cd "$ROOT" && find . -perm -o+w -print | head -5)"
check "$([[ -z "$writable" ]] && echo ok || echo fail)" "nothing in it is world-writable"

expect_equal "$(grep '^DOCKPLANE_VERSION=' "$ROOT/compose/.env.example")" \
	"DOCKPLANE_VERSION=$VERSION" "the example settings name this release"

expect_equal "$(jq -r .version "$ROOT/release-manifest.json")" "$VERSION" \
	"the manifest inside it is this release's"

# The offline images, when the build made them, are the ones the manifest
# names — not an archive left over from an earlier build in the same directory.
for image in controlServer web; do
	archive="$(jq -r ".images.$image.archive" "$MANIFEST")"

	[[ -n "$archive" && "$archive" != "null" ]] || continue

	check "$([[ -f "$ROOT/images/$archive" ]] && echo ok || echo fail)" \
		"carries $archive to install from"
done

echo
echo "==> what the bundle must not hold"

# Development state, in any of the forms it takes. A release is the product,
# and nothing about how it was made belongs in it.
private="$(cd "$ROOT" && find . \( \
	-name '.git*' -o -name 'node_modules' -o -name '*.log' -o -name '.DS_Store' -o \
	-name 'CLAUDE.md' -o -name 'AGENTS.md' -o -name '*.tmp' -o -name '*.bak' -o \
	-name '.env' -o -name 'package*.json' -o -name 'tsconfig*.json' \) -print)"

check "$([[ -z "$private" ]] && echo ok || echo fail)" "carries no development state"
[[ -n "$private" ]] && printf '        %s\n' "$private"

# Text a product does not contain. "Agent" is Dockplane's own word for the
# thing it installs on a host, so it is not one of these.
notes="$(grep -rilE 'claude|anthropic|chatgpt|copilot|generated by (an )?(ai|assistant)|as requested|prompt history' "$ROOT" || true)"

check "$([[ -z "$notes" ]] && echo ok || echo fail)" "reads as a product rather than as a transcript"
[[ -n "$notes" ]] && printf '        %s\n' "$notes"

# Nothing that is only ever a secret. The example settings deliberately name
# the files a secret is read from, which is not the same as carrying one.
secrets="$(grep -rlE 'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY|ghp_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}' "$ROOT" || true)"

check "$([[ -z "$secrets" ]] && echo ok || echo fail)" "carries no key, token or credential"
[[ -n "$secrets" ]] && printf '        %s\n' "$secrets"

echo
echo "==> the archive itself"

# Listed by GNU tar in the image the bundle is packed in, because BSD tar
# prints the same archive differently and this checker has to say the same
# thing on a release machine and on a developer's.
DEBIAN_IMAGE="${DEBIAN_IMAGE:-debian:12-slim}"
listing="$(docker run --rm --volume "$(cd "$(dirname "$BUNDLE")" && pwd):/work:ro" \
	--workdir /work "$DEBIAN_IMAGE" tar -tvzf "$(basename "$BUNDLE")")"

# Reproducible: one owner, one timestamp, no user names from the machine that
# packed it. Two builds of the same commit have to produce the same bytes, and
# these are the fields that otherwise differ.
owners="$(awk '{print $2}' <<< "$listing" | sort -u)"
expect_equal "$owners" "0/0" "every entry is owned by uid 0, gid 0"

stamps="$(awk '{print $4}' <<< "$listing" | sort -u | wc -l | tr -d ' ')"
expect_equal "$stamps" "1" "every entry carries the same timestamp"

top="$(awk '{print $NF}' <<< "$listing" | cut -d/ -f1 | sort -u)"
expect_equal "$top" "dockplane-$VERSION" "unpacks into one directory named for the release"

# The checksums a reader is told to verify.
if [[ -f "$OUT/SHA256SUMS" ]]; then
	if (cd "$OUT" && sha256sum -c SHA256SUMS > /dev/null 2>&1); then
		check ok "the checksums beside it verify"
	else
		check fail "the checksums beside it verify"
	fi

	check "$(grep -qF "$(bundle_name "$VERSION")" "$OUT/SHA256SUMS" && echo ok || echo fail)" \
		"the bundle is one of the things they cover"
fi

# --- the images -------------------------------------------------------------
#
# Read out of the OCI archives rather than from a local daemon: the archive is
# what the bundle installs and what was pushed, and a tag in somebody's daemon
# is neither.

blob() {
	local archive="$1" digest="$2"

	tar -xOf "$archive" "blobs/sha256/${digest#sha256:}"
}

for image in control-server web; do
	archive="$OUT/$image-$VERSION.oci.tar"

	[[ -f "$archive" ]] || continue

	echo
	echo "==> the $image image"

	index="$(tar -xOf "$archive" index.json)"
	list="$(jq -r '.manifests[0].digest' <<< "$index")"
	manifests="$(blob "$archive" "$list")"

	platforms="$(jq -r '[.manifests[] | select(.platform.os == "linux")
		| "\(.platform.os)/\(.platform.architecture)"] | unique | join(",")' <<< "$manifests")"

	expect_equal "$platforms" "linux/amd64,linux/arm64" "is built for both architectures"

	while read -r digest; do
		[[ -n "$digest" ]] || continue

		manifest="$(blob "$archive" "$digest")"
		config="$(blob "$archive" "$(jq -r .config.digest <<< "$manifest")")"
		architecture="$(jq -r .architecture <<< "$config")"

		user="$(jq -r '.config.User // ""' <<< "$config")"

		# The control server holds the deployment's data and must not be root.
		#
		# The web image is Caddy, which binds 80 and 443 and manages the
		# deployment's certificates, so it is root inside its own namespace and
		# carries nothing but static assets. Said here rather than passed over,
		# because an exception nobody wrote down is one nobody reconsiders.
		if [[ "$image" == "web" ]]; then
			check ok "$architecture is the proxy, which binds 80 and 443 as root"
		else
			check "$([[ -n "$user" && "$user" != "root" && "$user" != "0" ]] && echo ok || echo fail)" \
				"$architecture runs as a user of its own"
			[[ -z "$user" ]] && printf '        it runs as root\n'
		fi

		# What the layers remember about how they were built. A secret passed as
		# a build argument is in here for anyone who pulls the image.
		history="$(jq -r '[.history[].created_by] | join("\n")' <<< "$config")"
		leaked="$(grep -iE 'password=|secret=|token=|api[_-]?key=|BEGIN [A-Z ]*PRIVATE KEY' <<< "$history" || true)"

		check "$([[ -z "$leaked" ]] && echo ok || echo fail)" \
			"$architecture remembers no credential from its build"
		[[ -n "$leaked" ]] && printf '        %s\n' "$leaked"

		labels="$(jq -r '.config.Labels // {} | to_entries[] | "\(.key)=\(.value)"' <<< "$config")"
		expect_equal "$(grep -c "org.opencontainers.image.version=$VERSION" <<< "$labels" || true)" \
			"1" "$architecture is labelled with the version"
	done < <(jq -r '.manifests[] | select(.platform.os == "linux") | .digest' <<< "$manifests")
done

echo
if [[ "$failures" -gt 0 ]]; then
	printf '%d of %d checks failed\n' "$failures" "$checks"
	exit 1
fi

printf '%d/%d checks passed\n' "$checks" "$checks"
