#!/usr/bin/env bash
#
# Checks that a release gate cannot pass by not running.
#
#   deploy/test-tool-requirements.sh
#
# 0.1.0-rc.3 was verified on a machine without dpkg-deb, and the check that
# reads a package's declared version quietly did not happen. The run was green.
# A missing tool has to stop a gate, never shrink it, so:
#
#   1. every gate names the tools it invokes, and
#   2. removing one of those tools makes the gate fail.
#
# The first is a guard against drift — a script that grows a call to a tool it
# never declared. The second is the property itself.

set -uo pipefail

# The rule above applies to this script as much as to what it checks.
# Associative arrays arrived in bash 4, and on the bash 3.2 that macOS ships
# the table below is never built: every check went missing and the run reported
# success, which is the failure this file exists to prevent.
if [[ "${BASH_VERSINFO[0]:-0}" -lt 4 ]]; then
	echo "this needs bash 4 or newer; ${BASH_VERSION:-this shell} has no associative arrays" >&2
	echo "On macOS: brew install bash, then run it with that bash." >&2
	exit 3
fi

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
	if [[ "$2" == ok ]]; then
		printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"
		passed=$((passed + 1))
	else
		printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"
		failed=$((failed + 1))
	fi
}

# The scripts that stand between a build and a published release. Each is
# listed with the host tools it uses to decide whether a release is sound.
#
# Not every script that calls a tool belongs here — only the ones whose verdict
# a release depends on. A developer convenience may go missing without anybody
# being misled.
declare -A GATES=(
	[deploy/verify-release-assets.sh]="jq sha256sum dpkg-deb"
	[deploy/check-agent-release.sh]="docker file strings dpkg-deb sha256sum tar"
	[deploy/build-images.sh]="docker git sha256sum tar jq"
	[deploy/build-agent.sh]="docker git sha256sum"
	[deploy/scan-agent.sh]="docker jq tar"
	[deploy/test-release-verification.sh]="jq dpkg-deb sha256sum"
)

echo
echo "==> every gate names the tools it uses"

for script in "${!GATES[@]}"; do
	declared="${GATES[$script]}"

	# Line continuations are joined first, so a `docker run` spanning several
	# lines is read as the single command it is.
	joined=$(sed -e :a -e '/\\$/N; s/\\\n//; ta' "$script")

	# What the script actually calls. Only command positions count: the start of
	# a line, or after a pipe, a separator, an opening parenthesis or a command
	# substitution. Prose is full of words like "file" and "install", and
	# matching those would make this test noise.
	used=$(grep -oE '(^|[|;&(]|\$\()[[:space:]]*(jq|sha256sum|dpkg-deb|tar|file|strings|git|docker)[[:space:]]' \
		<<< "$joined" | grep -oE '(jq|sha256sum|dpkg-deb|tar|file|strings|git|docker)' | sort -u)

	# What runs inside a pinned container is that image's concern, not this
	# machine's, so a tool only ever invoked through `docker run` is excluded.
	in_container=$(grep -oE 'docker run .*' <<< "$joined" |
		grep -oE '\b(jq|sha256sum|dpkg-deb|tar|file|strings|git)\b' | sort -u)

	for tool in $in_container; do
		grep -qE "(^|[|;&(]|\\\$\()[[:space:]]*${tool}[[:space:]]" \
			<<< "$(grep -v 'docker run' <<< "$joined")" && in_container=$(grep -vw "$tool" <<< "$in_container")
	done

	undeclared=()
	for tool in $used; do
		grep -qw -- "$tool" <<< "$declared" && continue
		grep -qw -- "$tool" <<< "$in_container" && continue
		undeclared+=("$tool")
	done

	check "$(basename "$script") declares what it invokes" \
		"$([[ ${#undeclared[@]} -eq 0 ]] && echo ok || echo fail)"
	[[ ${#undeclared[@]} -gt 0 ]] && printf '     undeclared: %s\n' "${undeclared[*]}"

	# And what it declares, it checks for.
	unchecked=()
	for tool in $declared; do
		grep -qE "command -v \"?\\\$?[a-z]*\"? |for tool in .*$tool|command -v $tool" "$script" ||
			unchecked+=("$tool")
	done

	check "$(basename "$script") checks for them before it decides anything" \
		"$([[ ${#unchecked[@]} -eq 0 ]] && echo ok || echo fail)"
	[[ ${#unchecked[@]} -gt 0 ]] && printf '     not checked for: %s\n' "${unchecked[*]}"
done

echo
echo "==> and refuses to run without them"

# A PATH holding everything except the tool under test, so the script starts
# normally and then finds one thing missing.
sandbox="$(mktemp -d)"
trap 'rm -rf "$sandbox"' EXIT

ALL_TOOLS="jq sha256sum dpkg-deb dpkg tar file strings git docker bash sh env cat ls grep sed awk cut sort uniq head tail wc find mktemp rm cp mv install printf date tr basename dirname du stat chmod openssl curl"

path_without() {
	local omit="$1"
	local dir="$sandbox/without-${omit:-nothing}"
	local tool real

	rm -rf "$dir"
	mkdir -p "$dir"

	for tool in $ALL_TOOLS; do
		[[ -n "$omit" && "$tool" == "$omit" ]] && continue
		real="$(command -v "$tool" 2> /dev/null)" || continue
		ln -sf "$real" "$dir/$tool"
	done

	printf '%s' "$dir"
}

# A sandbox that is wrong in some other way would make every script exit
# non-zero, and every check below would pass without meaning anything. So the
# complete sandbox is proved usable first.
COMPLETE="$(path_without "")"
if PATH="$COMPLETE" bash -c 'command -v jq sha256sum dpkg-deb tar' > /dev/null 2>&1; then
	check "the sandboxed PATH is usable when nothing is removed" ok
else
	check "the sandboxed PATH is usable when nothing is removed" fail
	echo "     the checks below would pass for the wrong reason; stopping"
	exit 1
fi

refuses_without() {
	local script="$1" tool="$2"
	shift 2

	local dir status output
	dir="$(path_without "$tool")"

	output="$(PATH="$dir" "$script" "$@" 2>&1)"
	status=$?

	# Non-zero is necessary but not sufficient: a script that died because the
	# sandbox broke would also be non-zero. It has to say what is missing.
	local named=fail
	grep -qF -- "$tool" <<< "$output" && named=ok

	check "$(basename "$script") refuses without $tool, and says so (exit $status)" \
		"$([[ $status -ne 0 && "$named" == ok ]] && echo ok || echo fail)"

	if [[ $status -eq 0 || "$named" != ok ]]; then
		printf '     exit %s, and %s\n' "$status" \
			"$([[ "$named" == ok ]] && echo 'named the tool' || echo 'never named the tool')"
		head -3 <<< "$output" | sed 's/^/       /'
	fi
}

# A release directory that is otherwise entirely correct, so the only reason to
# fail is the missing tool.
fixture="$sandbox/release"
mkdir -p "$fixture/local" "$fixture/download"
# shellcheck source=deploy/release-assets.sh
source "$REPO_ROOT/deploy/release-assets.sh"
VERSION=0.1.0-rc.3

for name in $(release_asset_names "$VERSION" amd64 arm64); do
	printf 'contents of %s\n' "$name" > "$fixture/local/$name"
done

printf '{"version":"%s","commit":"%s","protocolVersion":1,"schemaVersion":"x","backupFormatVersion":1,"images":{"controlServer":{"digest":"sha256:%s"},"web":{"digest":"sha256:%s"}},"supplyChain":{"signature":"none"}}\n' \
	"$VERSION" "$(printf '0%.0s' {1..40})" "$(printf 'a%.0s' {1..64})" "$(printf 'b%.0s' {1..64})" \
	> "$fixture/local/$(manifest_name)"

for f in sbom-control-server sbom-web provenance-control-server provenance-web; do
	printf 'x\n' > "$fixture/local/$f-$VERSION.json"
done
printf 'x\n' > "$fixture/local/vulnerabilities-control-server-linux-amd64.json"

(cd "$fixture/local" && sha256sum ./* > "$(checksums_name)" 2> /dev/null)
sed -i.bak 's| \./| |' "$fixture/local/$(checksums_name)" && rm -f "$fixture/local/$(checksums_name).bak"
cp -R "$fixture/local/." "$fixture/download/"
(cd "$fixture/local" && ls) | jq -R -s 'split("\n") | map(select(length > 0)) | map({name: .})' \
	> "$fixture/assets.json"

for tool in jq sha256sum dpkg-deb; do
	refuses_without "$REPO_ROOT/deploy/verify-release-assets.sh" "$tool" \
		"$VERSION" "$fixture/local" "$fixture/assets.json" "$fixture/download"
done

for tool in jq dpkg-deb; do
	refuses_without "$REPO_ROOT/deploy/test-release-verification.sh" "$tool"
done

for tool in docker file strings dpkg-deb sha256sum tar; do
	refuses_without "$REPO_ROOT/deploy/check-agent-release.sh" "$tool" "$VERSION"
done

echo
echo "==> and no gate hides a check behind a tool being present"

# The shape that caused this: a validation that only runs where a tool happens
# to exist, with nothing said when it does not.
offenders=()
for script in "${!GATES[@]}"; do
	# `if command -v X` is only sound when the branch that follows fails, warns
	# or is not a verdict at all. Flag the ones with no negative branch.
	while IFS= read -r line; do
		[[ -z "$line" ]] && continue
		offenders+=("$script:$line")
	done < <(awk '
		/if +(!)? *command -v/ && !/!/ {
			found = NR ": " $0
			depth = 1
			has_else = 0
			while ((getline next_line) > 0) {
				if (next_line ~ /^\t*if /) depth++
				if (next_line ~ /^\t*else/ && depth == 1) has_else = 1
				if (next_line ~ /^\t*fi/) { depth--; if (depth == 0) break }
			}
			if (!has_else) print found
		}
	' "$script")
done

check "no verdict is skipped when a tool is missing" \
	"$([[ ${#offenders[@]} -eq 0 ]] && echo ok || echo fail)"
[[ ${#offenders[@]} -gt 0 ]] && printf '     %s\n' "${offenders[@]}"

echo
if [[ "$failed" -eq 0 ]]; then
	printf '%s%d passed, 0 failed%s\n' "$GREEN" "$passed" "$RESET"
else
	printf '%s%d passed, %d failed%s\n' "$RED" "$passed" "$failed" "$RESET"
fi

[[ "$failed" -eq 0 ]]
