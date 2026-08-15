#!/usr/bin/env bash
#
# Checks the properties a reproducible release depends on.
#
#   deploy/test-reproducibility.sh
#
# Proving reproducibility means building a release twice, which is what
# deploy/check-reproducible-build.sh does and why it is not run on every
# commit. What is cheap enough to run on every commit is the set of conditions
# that build has to satisfy: that every exporter is asked to rewrite its layer
# timestamps, that no command in a runtime stage can snapshot an emulator's
# scratch state, and that package metadata is derived from the package rather
# than from the disk it was staged on. Each of these was a real defect in
# 0.2.0-rc.3.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

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

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --- every exporter rewrites its layer timestamps ---------------------------
#
# SOURCE_DATE_EPOCH in the environment only stamps the image configuration. A
# release built without this option carries the minute it ran in every layer,
# which is what made 0.2.0-rc.3 unreproducible while looking correct.
echo
echo "image build"

outputs="$(grep -oE 'type=(image|oci|docker)[^"]*' deploy/build-images.sh)"

# The registry push, the OCI archive the bundle ships, and the local load. An
# exporter that stops being declared here stops being checked, so their number
# is asserted rather than assumed.
check "$([[ "$(wc -l <<< "$outputs")" -eq 3 ]] && echo ok || echo fail)" \
	"build-images.sh declares its three exporters explicitly"

while read -r output; do
	[[ -n "$output" ]] || continue

	kind="${output%%,*}"
	check "$([[ "$output" == *"rewrite-timestamp=true"* ]] && echo ok || echo fail)" \
		"$kind rewrites layer timestamps"
done <<< "$outputs"

# --load takes no options, so an exporter written that way cannot be asked for
# deterministic timestamps.
check "$(grep -qE '^\s*build_args\+=\(--load\)' deploy/build-images.sh && echo fail || echo ok)" \
	"no exporter is written as --load"

check "$(grep -q 'export SOURCE_DATE_EPOCH' deploy/build-images.sh && echo ok || echo fail)" \
	"SOURCE_DATE_EPOCH is exported to buildkit"

check "$(grep -qE 'SOURCE_DATE_EPOCH="\$\{SOURCE_DATE_EPOCH:-\$\(git log -1 --pretty=%ct' deploy/build-images.sh &&
	echo ok || echo fail)" \
	"SOURCE_DATE_EPOCH comes from the commit, not the clock"

# --- a runtime stage must not snapshot an emulator's scratch state ----------
#
# A command in the stage that becomes the image runs on the architecture being
# built, under emulation whenever that is not the machine's own. Rosetta writes
# its translation cache into the container filesystem, and the layer keeps it.
echo
echo "runtime stages"

runtime_commands() {
	local dockerfile="$1"

	awk '
		/^FROM/ { runtime = ($0 ~ /AS runtime/) }
		runtime && /^RUN/ { print }
	' "$dockerfile"
}

runtime_copies() {
	local dockerfile="$1"

	awk '
		/^FROM/ { runtime = ($0 ~ /AS runtime/) }
		runtime && /^COPY/ { print }
	' "$dockerfile"
}

for dockerfile in api/Dockerfile app/Dockerfile; do
	commands="$(runtime_commands "$dockerfile")"

	check "$([[ -n "$commands" ]] && echo ok || echo fail)" \
		"$dockerfile has a runtime stage to check"

	unguarded=0
	while read -r command; do
		[[ -n "$command" ]] || continue
		[[ "$command" == *"--mount=type=tmpfs,target=/root/.cache"* ]] || unguarded=1
	done <<< "$commands"

	check "$([[ $unguarded -eq 0 ]] && echo ok || echo fail)" \
		"$dockerfile keeps emulator scratch state out of the image"

	# A file copied out of the build context carries the modification time it
	# has on the machine doing the building — which is when that checkout was
	# made. Timestamps are only rewritten downwards, so an older one survives.
	# Anything a stage produces is written during the build and is stamped
	# with the commit's date instead.
	from_context=0
	while read -r copy; do
		[[ -n "$copy" ]] || continue
		[[ "$copy" == *"--from="* ]] || from_context=1
	done <<< "$(runtime_copies "$dockerfile")"

	check "$([[ $from_context -eq 0 ]] && echo ok || echo fail)" \
		"$dockerfile copies into the image only from a build stage"
done

# --- package metadata is a property of the package --------------------------
#
# Installed-Size was read with `du`, which answers with the block allocation of
# the filesystem the tree was staged on. The two builds of 0.2.0-rc.3 carried
# identical payloads and disagreed by 48 kilobytes.
echo
echo "installed size"

if ! command -v docker > /dev/null; then
	check fail "docker is available to compute an installed size"
else
	# A file of a known size in each of the interesting shapes: under a
	# kilobyte, exactly a kilobyte, and a fraction over.
	dense="$work/dense"
	mkdir -p "$dense/usr/bin" "$dense/etc"
	head -c 1 /dev/zero > "$dense/usr/bin/one-byte"
	head -c 1024 /dev/zero > "$dense/etc/exactly-one-kilobyte"
	head -c 1025 /dev/zero > "$dense/etc/just-over"

	# Four directories at a kilobyte each — the tree, usr, usr/bin, etc — and
	# 1 + 1 + 2 for the files, the last of which is a byte into its second
	# kilobyte.
	expected=8

	measured="$(deploy/installed-size.sh "$dense")"
	check "$([[ "$measured" == "$expected" ]] && echo ok || echo fail)" \
		"a known payload measures $expected kilobytes (got ${measured:-nothing})"

	# The same logical content, stored so that the filesystem allocates a
	# different number of blocks for it. This is the difference `du` reports
	# and the package must not.
	sparse="$work/sparse"
	mkdir -p "$sparse/usr/bin" "$sparse/etc"
	head -c 1 /dev/zero > "$sparse/usr/bin/one-byte"
	head -c 1024 /dev/zero > "$sparse/etc/exactly-one-kilobyte"
	docker run --rm -v "$sparse/etc:/etc/target" debian:12-slim \
		truncate -s 1025 /etc/target/just-over

	sparse_measured="$(deploy/installed-size.sh "$sparse")"
	check "$([[ "$sparse_measured" == "$measured" ]] && echo ok || echo fail)" \
		"the same payload measures the same on a different allocation"

	# And the check that this test is worth having: the measurement it
	# replaced does not survive the same comparison.
	dense_du="$(docker run --rm -v "$dense:/tree:ro" debian:12-slim du -ks /tree | cut -f1)"
	sparse_du="$(docker run --rm -v "$sparse:/tree:ro" debian:12-slim du -ks /tree | cut -f1)"
	check "$([[ "$dense_du" != "$sparse_du" ]] && echo ok || echo fail)" \
		"du disagrees on that pair, which is why it is not used ($dense_du vs $sparse_du)"
fi

# --- the double build cannot be satisfied by a cache ------------------------
echo
echo "reproducibility gate"

gate=deploy/check-reproducible-build.sh

check "$([[ -x "$gate" ]] && echo ok || echo fail)" \
	"the double-build gate exists and is executable"

check "$(grep -q 'unset BUILDX_BUILDER' "$gate" && echo ok || echo fail)" \
	"the gate ignores an inherited builder"

check "$(grep -qE 'docker buildx create --name "\$builder"' "$gate" && echo ok || echo fail)" \
	"the gate creates a builder for each build"

check "$(grep -qE 'BUILDER_A=.*\n?' "$gate" && grep -q 'BUILDER_B=' "$gate" && echo ok || echo fail)" \
	"the gate names two different builders"

check "$(grep -q 'cache-from' "$gate" && echo fail || echo ok)" \
	"the gate passes no cache between the builds"

check "$(grep -q 'git archive' "$gate" && echo ok || echo fail)" \
	"the second build reads an export of the commit"

check "$(grep -q '_amd64.deb' "$gate" && grep -q '_arm64.deb' "$gate" && echo ok || echo fail)" \
	"the gate compares whole packages, not only their payloads"

echo
if [[ $failed -eq 0 ]]; then
	echo "$passed passed, 0 failed"
	exit 0
fi

echo "$passed passed, $failed failed" >&2
exit 1
