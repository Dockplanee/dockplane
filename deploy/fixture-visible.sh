#!/usr/bin/env bash
#
# Answers whether the docker daemon can see a directory the way this machine
# sees it.
#
#   deploy/fixture-visible.sh dist/agent/deb/amd64
#
# A bind mount names a path, and the daemon resolves that path in its own
# filesystem rather than in the caller's. Where the two are the same machine
# they agree. Where they are not — a script running inside a container that
# talks to the host's docker socket — the daemon finds nothing at that path and
# creates an empty directory there, and the container is handed that instead of
# what was prepared. Nothing fails: the mount succeeds and the measurement is
# taken on an empty tree.
#
# So the daemon is asked to read the directory back, and what it reports has to
# be exactly what is there. A tree that is empty on this side is refused too:
# it cannot tell a working mount from a substituted one, which is the whole
# question.

set -uo pipefail

TREE="${1:-}"
DEBIAN_IMAGE="${DEBIAN_IMAGE:-debian:12-slim}"

if [[ -z "$TREE" ]]; then
	echo "usage: $0 <directory>" >&2
	exit 2
fi

if [[ ! -d "$TREE" ]]; then
	echo "no such directory: $TREE" >&2
	exit 2
fi

here="$(cd "$TREE" && find . | sort)"

if [[ "$(wc -l <<< "$here")" -le 1 ]]; then
	echo "$TREE is empty; a mount of it would prove nothing" >&2
	exit 3
fi

there="$(docker run --rm -v "$(cd "$TREE" && pwd):/tree:ro" "$DEBIAN_IMAGE" \
	sh -c 'cd /tree && find .' 2>/dev/null | sort)"

if [[ "$here" == "$there" ]]; then
	exit 0
fi

echo "the docker daemon does not see $TREE" >&2
echo >&2
echo "  prepared here: $(wc -l <<< "$here" | tr -d ' ') entries" >&2
echo "  seen by the daemon: $(wc -l <<< "${there:-}" | tr -d ' ') entries" >&2
echo >&2
echo "This machine and the daemon do not share a filesystem, which is what" >&2
echo "happens when this runs inside a container using the host's docker" >&2
echo "socket. The mount succeeded and delivered an empty directory." >&2
exit 1
