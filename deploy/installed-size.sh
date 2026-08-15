#!/usr/bin/env bash
#
# Prints the Installed-Size a Debian package tree should declare, in kilobytes.
#
#   deploy/installed-size.sh dist/agent/deb/amd64
#
# The rule is dpkg's own: every file and symlink is rounded up to a whole
# kilobyte, every other object counts as one kilobyte because directories are
# shared between packages, and content reachable under more than one name is
# counted once.
#
# Deliberately not `du`, which answers with the block allocation of whichever
# filesystem the tree happens to sit on. 0.2.0-rc.3 shipped packages whose
# payloads were byte-identical between a developer machine and CI while their
# control files claimed 8184 and 8232 kilobytes, and that one field was enough
# to make the two packages different files.
#
# Read in a container rather than on the host: BSD find cannot print the fields
# this needs, so the answer would otherwise depend on which machine asked.

set -euo pipefail

TREE="${1:-}"
DEBIAN_IMAGE="${DEBIAN_IMAGE:-debian:12-slim}"

if [[ -z "$TREE" ]]; then
	echo "usage: $0 <package tree>" >&2
	exit 2
fi

if [[ ! -d "$TREE" ]]; then
	echo "no such directory: $TREE" >&2
	exit 2
fi

absolute="$(cd "$TREE" && pwd)"

docker run --rm \
	-v "$absolute:/tree:ro" \
	"$DEBIAN_IMAGE" \
	find /tree -printf '%y %i %n %s\n' |
	awk '
		$1 == "f" || $1 == "l" {
			# Hardlinked content occupies the disk once, so it is counted once.
			if ($3 > 1 && seen[$2]++) {
				next
			}

			total += int(($4 + 1023) / 1024)
			next
		}

		{ total += 1 }

		END { print total + 0 }
	'
