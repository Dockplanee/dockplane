#!/usr/bin/env bash
#
# Checks that the documentation describes this product and points at pages that
# exist.
#
#   deploy/check-docs.sh
#
# Documentation goes stale in ways nobody notices until somebody follows it and
# it does not work. Three of those are worth a gate:
#
#   a link to a page that was moved or renamed
#   a shell example that is not valid shell
#   a file name from a release that is no longer the current one
#
# The last is not hypothetical. The getting-started pages told operators to
# install dockplane-agent_0.1.0~rc.2_amd64.deb, which was never published under
# that name — the tilde belongs in the package's Version field, not in a file
# name, and following that instruction gave a 404.

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
	if [[ "$2" == ok ]]; then
		printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"
		passed=$((passed + 1))
	else
		printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"
		failed=$((failed + 1))
	fi
}

# Everything that is documentation, as opposed to a design specification or a
# release note describing a version that has already happened.
mapfile -t PAGES < <(find docs -name '*.md' -not -path 'docs/releases/*' | sort)
PAGES+=(README.md CONTRIBUTING.md SECURITY.md CHANGELOG.md)

echo
echo "==> every link points at something"

broken=()

for page in "${PAGES[@]}"; do
	[[ -f "$page" ]] || continue
	dir="$(dirname "$page")"

	# Markdown links to a relative path. External links, anchors and mail are
	# somebody else's to keep working.
	while IFS= read -r target; do
		[[ -z "$target" ]] && continue
		[[ "$target" =~ ^(https?:|mailto:|#) ]] && continue

		path="${target%%#*}"
		[[ -z "$path" ]] && continue

		if [[ ! -e "$dir/$path" ]]; then
			broken+=("$page -> $target")
		fi
	done < <(grep -oE '\]\([^)]+\)' "$page" | sed 's/^](//; s/)$//')
done

check "no link points at a page that is not there" \
	"$([[ ${#broken[@]} -eq 0 ]] && echo ok || echo fail)"
[[ ${#broken[@]} -gt 0 ]] && printf '     %s\n' "${broken[@]}"

echo
echo "==> every anchor points at a heading that exists"

# An anchor into the same repository, checked against the headings of the page
# it names. GitHub derives an anchor from a heading by lowercasing it, dropping
# anything that is not a word character, space or hyphen, and joining with
# hyphens.
bad_anchors=()

slugs_of() {
	grep -E '^#{1,6} ' "$1" |
		sed -E 's/^#+ +//' |
		tr '[:upper:]' '[:lower:]' |
		sed -E 's/[^a-z0-9 _-]//g; s/ +/-/g'
}

for page in "${PAGES[@]}"; do
	[[ -f "$page" ]] || continue
	dir="$(dirname "$page")"

	while IFS= read -r target; do
		[[ "$target" =~ ^(https?:|mailto:) ]] && continue
		[[ "$target" == *"#"* ]] || continue

		anchor="${target#*#}"
		path="${target%%#*}"
		[[ -z "$anchor" ]] && continue

		if [[ -z "$path" ]]; then
			file="$page"
		else
			file="$dir/$path"
		fi

		[[ -f "$file" ]] || continue
		grep -qxF "$anchor" <<< "$(slugs_of "$file")" || bad_anchors+=("$page -> $target")
	done < <(grep -oE '\]\([^)]+\)' "$page" | sed 's/^](//; s/)$//')
done

check "no anchor points at a heading that is not there" \
	"$([[ ${#bad_anchors[@]} -eq 0 ]] && echo ok || echo fail)"
[[ ${#bad_anchors[@]} -gt 0 ]] && printf '     %s\n' "${bad_anchors[@]}"

echo
echo "==> every shell example is valid shell"

bad_shell=()

for page in "${PAGES[@]}"; do
	[[ -f "$page" ]] || continue

	# Each ```bash block, checked on its own. A block is an excerpt rather than a
	# script, so this asks whether bash can parse it, not whether it would run.
	awk -v page="$page" '
		/^```bash$/ { collecting = 1; block = ""; start = NR; next }
		/^```$/ && collecting {
			collecting = 0
			file = "/tmp/docs-block-" NR ".sh"
			printf "%s", block > file
			close(file)
			print file "\t" page ":" start
			next
		}
		collecting { block = block $0 "\n" }
	' "$page" | while IFS=$'\t' read -r file where; do
		bash -n "$file" 2> /dev/null || echo "$where"
		rm -f "$file"
	done
done > /tmp/docs-shell-errors

mapfile -t bad_shell < /tmp/docs-shell-errors
rm -f /tmp/docs-shell-errors

check "no shell example fails to parse" \
	"$([[ ${#bad_shell[@]} -eq 0 ]] && echo ok || echo fail)"
[[ ${#bad_shell[@]} -gt 0 ]] && printf '     %s\n' "${bad_shell[@]}"

echo
echo "==> nothing names a file the project does not publish"

# shellcheck source=deploy/release-assets.sh
source "$REPO_ROOT/deploy/release-assets.sh"

stale=()

for page in "${PAGES[@]}"; do
	[[ -f "$page" ]] || continue

	# A tilde in an agent package file name is the 0.1.0-rc.2 mistake. It belongs
	# in the Version field and nowhere else.
	while IFS= read -r line; do
		stale+=("$page: $line")
	done < <(grep -oE 'dockplane-agent_[0-9][^ `)"]*~[^ `)"]*' "$page")

	# A pinned release number in an operator instruction dates the page. Release
	# notes are allowed to name their own version; getting-started is not.
	while IFS= read -r line; do
		stale+=("$page: $line")
	done < <(grep -oE '(dockplane-agent_|dockplane-)[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?[._]' "$page")
done

check "no documented file name carries a tilde or a pinned version" \
	"$([[ ${#stale[@]} -eq 0 ]] && echo ok || echo fail)"
[[ ${#stale[@]} -gt 0 ]] && printf '     %s\n' "${stale[@]}"

echo
echo "==> the structure the documentation promises is there"

for required in \
	docs/README.md \
	docs/getting-started/overview.md \
	docs/getting-started/installation.md \
	docs/getting-started/add-host.md \
	docs/operations/upgrade.md \
	docs/operations/backup-restore.md \
	docs/operations/agent.md \
	docs/operations/troubleshooting.md \
	docs/security/security-model.md \
	docs/security/agent-security.md \
	docs/security/authentication.md \
	docs/reference/architecture.md \
	docs/reference/supported-platforms.md \
	docs/reference/known-limitations.md; do
	check "$required" "$([[ -f "$required" ]] && echo ok || echo fail)"
done

echo
if [[ "$failed" -eq 0 ]]; then
	printf '%s%d passed, 0 failed%s\n' "$GREEN" "$passed" "$RESET"
else
	printf '%s%d passed, %d failed%s\n' "$RED" "$passed" "$failed" "$RESET"
fi

[[ "$failed" -eq 0 ]]
