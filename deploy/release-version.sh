#!/usr/bin/env bash
#
# Turns a release tag into the version the artefacts carry.
#
#   deploy/release-version.sh v0.1.0-rc.2
#     version=0.1.0-rc.2
#     tag=v0.1.0-rc.2
#     prerelease=true
#
# The tag is the only thing a release build receives from outside, and it
# arrives from whoever could push it. It is matched against one expression and
# either produces a version or stops the build; nothing downstream re-parses it,
# and no part of it is ever expanded by a shell.

set -euo pipefail

TAG="${1:-}"

if [[ -z "$TAG" ]]; then
	echo "usage: $0 <tag>   e.g. $0 v0.1.0-rc.2" >&2
	exit 2
fi

# v<major>.<minor>.<patch>[-<alpha|beta|rc>.<n>]
#
# Deliberately narrower than SemVer: build metadata, arbitrary pre-release
# identifiers and branch-shaped tags are all refused rather than turned into a
# version somebody has to interpret.
if [[ ! "$TAG" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)(-(alpha|beta|rc)\.([0-9]+))?$ ]]; then
	cat >&2 <<-MESSAGE
		not a release tag: $TAG

		expected  v<major>.<minor>.<patch>[-rc.<n>]
		examples  v0.1.0-rc.2   v0.1.0   v1.2.3-beta.4
	MESSAGE
	exit 3
fi

CORE="${BASH_REMATCH[1]}"
PRERELEASE_ID="${BASH_REMATCH[3]:-}"
PRERELEASE_NUMBER="${BASH_REMATCH[4]:-}"

VERSION="$CORE"
[[ -n "$PRERELEASE_ID" ]] && VERSION="$CORE-$PRERELEASE_ID.$PRERELEASE_NUMBER"

# A release candidate is published as a prerelease, so that whoever downloads
# the newest release gets the newest one meant for production.
if [[ -n "$PRERELEASE_ID" ]]; then
	PRERELEASE="true"
else
	PRERELEASE="false"
fi

cat <<VALUES
version=$VERSION
tag=$TAG
prerelease=$PRERELEASE
VALUES
