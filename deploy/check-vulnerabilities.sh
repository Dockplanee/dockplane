#!/usr/bin/env bash
#
# Applies the release vulnerability policy to Trivy's output.
#
#   deploy/check-vulnerabilities.sh dist/scan/*.json
#
# The policy is deliberately narrow, because a gate that fails on everything is
# a gate somebody switches off:
#
#   a CRITICAL with a fix available   stops the release
#   a CRITICAL nobody has assessed    stops the release
#   a CRITICAL carried on purpose     is listed, with the reason
#   a HIGH with a fix available       is reported, and does not stop anything
#
# The assessments live in deploy/accepted-vulnerabilities.txt, next to this
# file, so a decision and the gate that honours it are read together.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACCEPTED="${ACCEPTED:-$REPO_ROOT/deploy/accepted-vulnerabilities.txt}"

if [[ $# -eq 0 ]]; then
	echo "usage: $0 <trivy-report.json> [...]" >&2
	exit 2
fi

command -v jq > /dev/null || {
	echo "jq is required to read Trivy's output" >&2
	exit 3
}

[[ -f "$ACCEPTED" ]] || {
	echo "missing assessments: $ACCEPTED" >&2
	exit 3
}

# "CVE-1234-5678 package" per accepted entry, comments and blank lines dropped.
accepted="$(sed 's/#.*//' "$ACCEPTED" | awk 'NF >= 2 { print $1, $2 }' | sort -u)"

blocking=0
fixable_high=0
seen_criticals=""

# Trivy reports one file per image and platform; every one of them is read, so
# a finding that exists on only one architecture is not lost in a summary.
for report in "$@"; do
	[[ -f "$report" ]] || {
		echo "no such report: $report" >&2
		exit 3
	}

	subject="$(basename "$report" .json)"

	findings="$(jq -r '
		[.Results[]? | .Vulnerabilities[]?
		 | select(.Severity == "CRITICAL" or .Severity == "HIGH")
		 | {
		     id: .VulnerabilityID,
		     package: .PkgName,
		     severity: .Severity,
		     installed: (.InstalledVersion // ""),
		     fixed: (.FixedVersion // "")
		   }]
		| unique_by([.id, .package])
		| .[]
		| [.severity, .id, .package, .installed, .fixed] | @tsv
	' "$report")"

	criticals="$(grep -c '^CRITICAL' <<< "$findings" || true)"
	highs="$(grep -c '^HIGH' <<< "$findings" || true)"

	printf '==> %s\n    %s critical, %s high\n' "$subject" "$criticals" "$highs"

	while IFS=$'\t' read -r severity id package installed fixed; do
		[[ -n "$severity" ]] || continue

		if [[ "$severity" == CRITICAL ]]; then
			seen_criticals+="$id $package"$'\n'

			if [[ -n "$fixed" ]]; then
				printf '    BLOCKING  %s %s: fixed in %s\n' "$id" "$package" "$fixed"
				blocking=$((blocking + 1))
				continue
			fi

			if ! grep -qxF "$id $package" <<< "$accepted"; then
				printf '    BLOCKING  %s %s: critical with no assessment\n' "$id" "$package"
				blocking=$((blocking + 1))
				continue
			fi

			printf '    carried   %s %s %s\n' "$id" "$package" "$installed"
			continue
		fi

		if [[ -n "$fixed" ]]; then
			printf '    high      %s %s: fixed in %s\n' "$id" "$package" "$fixed"
			fixable_high=$((fixable_high + 1))
		fi
	done <<< "$findings"
done

# An assessment for something that is no longer there is stale, and a stale
# assessment is how a real finding eventually gets waved through.
while read -r id package; do
	[[ -n "$id" ]] || continue
	grep -qxF "$id $package" <<< "$seen_criticals" ||
		printf '==> assessment no longer applies: %s %s — remove it from %s\n' \
			"$id" "$package" "$(basename "$ACCEPTED")"
done <<< "$accepted"

echo
if [[ "$fixable_high" -gt 0 ]]; then
	echo "$fixable_high high findings have a fix available. They do not stop this release;"
	echo "they belong in the next one."
fi

if [[ "$blocking" -gt 0 ]]; then
	echo "$blocking critical findings stop this release." >&2
	echo "Fix them, or assess them in $(basename "$ACCEPTED") with a reason." >&2
	exit 1
fi

echo "no critical finding stops this release."
