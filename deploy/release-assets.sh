#!/usr/bin/env bash
#
# What a release is called.
#
#   source deploy/release-assets.sh
#   agent_package_name 0.1.0-rc.3 amd64   -> dockplane-agent_0.1.0-rc.3_amd64.deb
#   debian_version 0.1.0-rc.3             -> 0.1.0~rc.3
#
# Every component that names a release artefact reads it from here: the build
# scripts, the checks, the manifest, the workflow that uploads them and the
# installer the control plane hands to a new host. A name assembled twice is a
# name that eventually differs in one place, and the one that differs is
# whichever nobody tested.
#
# Two versions, deliberately kept apart:
#
#   0.1.0-rc.3   the product version. Everything an operator sees, every image
#                tag, every file name.
#   0.1.0~rc.3   the Debian package version, and nothing else. A tilde is what
#                dpkg reads as "earlier than", so 0.1.0~rc.3 correctly precedes
#                0.1.0; a hyphen would start a package revision and sort after
#                it, making the final release look like a downgrade.
#
# The tilde belongs in the package's Version field. It does not belong in a file
# name: GitHub rewrites a tilde in a release asset to a full stop, so a file
# published under one name would be requested under another and 404.

# The Debian Version field. Not a file name.
#
# Written with tr: bash 5.2 and later perform tilde expansion on the replacement
# of a pattern substitution, which would turn this into a home directory.
debian_version() {
	printf '%s' "$1" | tr '-' '~'
}

agent_package_name() {
	printf 'dockplane-agent_%s_%s.deb' "$1" "$2"
}

agent_tarball_name() {
	printf 'dockplane-agent_%s_linux_%s.tar.gz' "$1" "$2"
}

bundle_name() {
	printf 'dockplane-%s.tar.gz' "$1"
}

# What a release scans. The two control-plane images come from the registry,
# the agent from the binary in its release tarball; all three are published as
# one report per architecture.
VULNERABILITY_SUBJECTS=(control-server web agent)

# The vulnerability report published for one subject and one architecture.
#
# The scan writes <subject>-linux-<arch>.json and the release prefixes every
# report the same way, so the published name is assembled here rather than
# assumed in the workflow and again in the check that looks for it.
vulnerability_report_name() {
	printf 'vulnerabilities-%s-linux-%s.json' "$1" "$2"
}

# Every vulnerability report a release publishes.
#
# Required by name, because a report expected only because a file happens to be
# on disk is a report whose absence nobody notices. A scan that never ran and a
# scan that found nothing produce the same silence otherwise.
vulnerability_report_names() {
	local architectures=("$@")
	local subject arch

	for subject in "${VULNERABILITY_SUBJECTS[@]}"; do
		for arch in "${architectures[@]}"; do
			vulnerability_report_name "$subject" "$arch"
			printf '\n'
		done
	done
}

checksums_name() {
	printf 'SHA256SUMS'
}

manifest_name() {
	printf 'release-manifest.json'
}

# Every file a release publishes, for one version and one set of architectures.
# The order is the order they are listed in, which is the order they appear in
# the checksum file.
release_asset_names() {
	local version="$1"
	shift
	local architectures=("$@")
	local arch

	bundle_name "$version"
	printf '\n'

	for arch in "${architectures[@]}"; do
		agent_package_name "$version" "$arch"
		printf '\n'
	done

	for arch in "${architectures[@]}"; do
		agent_tarball_name "$version" "$arch"
		printf '\n'
	done
}

# Refuses a name that will not survive being uploaded. GitHub replaces
# characters it does not accept in an asset name, and a release whose files are
# fetched under a different name than they were published under is a release
# nobody can install from.
assert_publishable() {
	local name="$1"

	if [[ ! "$name" =~ ^[A-Za-z0-9._-]+$ ]]; then
		echo "not a publishable asset name: $name" >&2
		echo "A release asset may contain letters, digits, dots, hyphens and underscores." >&2
		return 1
	fi
}
