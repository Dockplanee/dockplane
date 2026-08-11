#!/usr/bin/env bash
#
# Checks the release path as far as it can be checked without publishing.
#
#   deploy/test-release.sh
#
# A release workflow is difficult to test by running it: the interesting part
# only happens once, on a tag, and it writes to places that are not easy to
# take back. So the parts that can be exercised are exercised here — how a tag
# becomes a version, what the vulnerability policy blocks, and what the
# workflows are permitted to do — and the rest is left to the tag.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

WORKFLOWS="$REPO_ROOT/.github/workflows"
VERSION_SCRIPT="$REPO_ROOT/deploy/release-version.sh"
POLICY_SCRIPT="$REPO_ROOT/deploy/check-vulnerabilities.sh"

if [[ -t 1 ]]; then
	RED=$'\033[31m' GREEN=$'\033[32m' RESET=$'\033[0m'
else
	RED='' GREEN='' RESET=''
fi

passed=0
failed=0

check() {
	local description="$1" condition="$2"

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

# --- a tag becomes a version, or it becomes nothing -------------------------
echo
echo "tag parsing"

field() {
	"$VERSION_SCRIPT" "$1" 2> /dev/null | grep "^$2=" | cut -d= -f2-
}

accepts() {
	local tag="$1" want_version="$2" want_prerelease="$3"

	check "$tag -> $want_version" \
		"$([[ "$(field "$tag" version)" == "$want_version" ]] && echo ok || echo fail)"
	check "$tag is prerelease=$want_prerelease" \
		"$([[ "$(field "$tag" prerelease)" == "$want_prerelease" ]] && echo ok || echo fail)"
}

accepts v0.1.0-rc.2 0.1.0-rc.2 true
accepts v0.1.0 0.1.0 false
accepts v1.2.3-beta.4 1.2.3-beta.4 true
accepts v0.2.0-rc.10 0.2.0-rc.10 true
accepts v10.20.30 10.20.30 false

refuses() {
	local tag="$1"

	"$VERSION_SCRIPT" "$tag" > /dev/null 2>&1
	check "refuses ${2:-$tag}" "$([[ $? -ne 0 ]] && echo ok || echo fail)"
}

refuses main
refuses v0.1.0-rc2
refuses v0.1
refuses 0.1.0
refuses v0.1.0-alpha
refuses v0.1.0+build.5
refuses release-0.1.0
refuses v0.1.0-rc.1-test

# A tag is pushed by whoever can push tags, and it reaches a shell. These are
# the shapes that matter if it were ever expanded rather than compared.
refuses 'v0.1.0-rc.1; id' 'a tag with a command separator'
refuses 'v0.1.0$(id)' 'a tag with a command substitution'
refuses 'v0.1.0`id`' 'a tag with a backquote'
refuses 'v0.1.0-rc.1
v9.9.9' 'a tag with a newline'
refuses '../../v0.1.0' 'a tag with a path traversal'

"$VERSION_SCRIPT" > /dev/null 2>&1
check "refuses an empty tag" "$([[ $? -eq 2 ]] && echo ok || echo fail)"

# Whatever comes out is used to name files and image tags, so it may never
# contain anything a shell or a path would read as structure.
for tag in v0.1.0-rc.2 v1.2.3-beta.4 v0.2.0; do
	version="$(field "$tag" version)"
	check "$tag yields a version of safe characters only" \
		"$([[ "$version" =~ ^[0-9A-Za-z.-]+$ ]] && echo ok || echo fail)"
done

# --- the vulnerability policy ------------------------------------------------
echo
echo "vulnerability policy"

if ! command -v jq > /dev/null; then
	echo "  jq is required for these checks" >&2
	failed=$((failed + 1))
else
	report() {
		local file="$1" severity="$2" id="$3" package="$4" fixed="$5"

		cat > "$file" <<-JSON
			{
			  "Results": [
			    {
			      "Target": "test",
			      "Vulnerabilities": [
			        {
			          "VulnerabilityID": "$id",
			          "PkgName": "$package",
			          "Severity": "$severity",
			          "InstalledVersion": "1.0",
			          "FixedVersion": "$fixed"
			        }
			      ]
			    }
			  ]
			}
		JSON
	}

	report "$work/carried.json" CRITICAL CVE-2023-45853 zlib1g ""
	"$POLICY_SCRIPT" "$work/carried.json" > /dev/null 2>&1
	check "an assessed critical with no fix is carried" "$([[ $? -eq 0 ]] && echo ok || echo fail)"

	report "$work/fixable.json" CRITICAL CVE-2023-45853 zlib1g "1.1"
	"$POLICY_SCRIPT" "$work/fixable.json" > /dev/null 2>&1
	check "an assessed critical that became fixable stops the release" \
		"$([[ $? -ne 0 ]] && echo ok || echo fail)"

	report "$work/unassessed.json" CRITICAL CVE-2099-00001 openssl ""
	"$POLICY_SCRIPT" "$work/unassessed.json" > /dev/null 2>&1
	check "an unassessed critical stops the release" "$([[ $? -ne 0 ]] && echo ok || echo fail)"

	report "$work/wrong-package.json" CRITICAL CVE-2023-45853 openssl ""
	"$POLICY_SCRIPT" "$work/wrong-package.json" > /dev/null 2>&1
	check "an assessment does not carry over to another package" \
		"$([[ $? -ne 0 ]] && echo ok || echo fail)"

	report "$work/high.json" HIGH CVE-2099-00002 curl "8.0"
	"$POLICY_SCRIPT" "$work/high.json" > /dev/null 2>&1
	check "a fixable high is reported and does not stop the release" \
		"$([[ $? -eq 0 ]] && echo ok || echo fail)"

	output="$("$POLICY_SCRIPT" "$work/high.json" 2>&1)"
	check "a fixable high says where the fix is" \
		"$([[ "$output" == *"fixed in 8.0"* ]] && echo ok || echo fail)"

	output="$("$POLICY_SCRIPT" "$work/carried.json" 2>&1)"
	check "an assessment that no longer applies is reported" \
		"$([[ "$output" == *"no longer applies"* ]] && echo ok || echo fail)"

	"$POLICY_SCRIPT" "$work/does-not-exist.json" > /dev/null 2>&1
	check "a missing report is an error, not an empty pass" \
		"$([[ $? -ne 0 ]] && echo ok || echo fail)"

	"$POLICY_SCRIPT" > /dev/null 2>&1
	check "refuses to run with no report at all" "$([[ $? -eq 2 ]] && echo ok || echo fail)"

	malformed="$(sed 's/#.*//' deploy/accepted-vulnerabilities.txt |
		awk 'NF > 0 && (NF < 2 || $1 !~ /^CVE-[0-9]+-[0-9]+$/) { print }')"
	check "every assessment names a CVE and a package" \
		"$([[ -z "$malformed" ]] && echo ok || echo fail)"
fi

# --- what the workflows are allowed to do ------------------------------------
echo
echo "workflows"

for workflow in ci.yml quality.yml release.yml; do
	check "$workflow exists" "$([[ -f "$WORKFLOWS/$workflow" ]] && echo ok || echo fail)"
done

release="$WORKFLOWS/release.yml"
ci="$WORKFLOWS/ci.yml"
quality="$WORKFLOWS/quality.yml"

check "a release is triggered by a tag" \
	"$(grep -q "^  push:" "$release" && grep -q "^    tags:" "$release" && echo ok || echo fail)"
check "a release is triggered only by a version tag" \
	"$(grep -q "^      - 'v\*'" "$release" && echo ok || echo fail)"
check "a release is not triggered by a branch" \
	"$(grep -q "branches:" "$release" && echo fail || echo ok)"
check "a release is not triggered by hand" \
	"$(grep -q "workflow_dispatch" "$release" && echo fail || echo ok)"
check "a release grants nothing by default" \
	"$(grep -q "^permissions: {}" "$release" && echo ok || echo fail)"
check "a release is never cancelled by a later one" \
	"$(grep -q "cancel-in-progress: false" "$release" && echo ok || echo fail)"

check "only the image job may write packages" \
	"$([[ "$(grep -c "packages: write" "$release")" == "1" ]] && echo ok || echo fail)"
check "only the release job may write contents" \
	"$([[ "$(grep -c "contents: write" "$release")" == "1" ]] && echo ok || echo fail)"
check "the release job waits for every gate" \
	"$(grep -q "needs: \[tag, quality, agent, images, scan\]" "$release" && echo ok || echo fail)"
check "the image push waits for the gates" \
	"$(grep -q "needs: \[tag, quality, agent\]" "$release" && echo ok || echo fail)"

check "CI grants nothing by default" \
	"$(grep -q "^permissions: {}" "$ci" && echo ok || echo fail)"
check "CI cannot write packages" \
	"$(grep -q "packages: write" "$ci" && echo fail || echo ok)"
check "CI cannot write contents" \
	"$(grep -q "contents: write" "$ci" && echo fail || echo ok)"
check "CI never pushes an image" \
	"$(grep -qE "PUSH: '1'|docker login|docker push" "$ci" && echo fail || echo ok)"
check "CI never creates a release" \
	"$(grep -q "gh release" "$ci" && echo fail || echo ok)"
check "the gates are read-only" \
	"$(grep -qE "contents: write|packages: write" "$quality" && echo fail || echo ok)"

# The integration tests run against a real PostgreSQL. A runner has none unless
# the workflow provides one, and without it the whole suite fails at the first
# migration — which is not a failure anybody reads as "no database".
shipped_postgres="$(grep -oE "image: postgres:[^ ]+" deploy/compose/compose.yaml | head -1 | cut -d' ' -f2)"
gate_postgres="$(grep -oE "image: postgres:[^ ]+" "$quality" | head -1 | cut -d' ' -f2)"

check "the control server gate is given a database" \
	"$([[ -n "$gate_postgres" ]] && echo ok || echo fail)"
check "the gate's database is the one the stack ships" \
	"$([[ "$gate_postgres" == "$shipped_postgres" ]] && echo ok || echo fail)"
check "the gate names the database it connects to" \
	"$(grep -q "DATABASE_URL: postgres://" "$quality" && echo ok || echo fail)"

# Everything the release publishes under is named in one place, and that place
# is the same one the build scripts default to.
for image in dockplane-control-server dockplane-web; do
	check "$image is what the workflow publishes" \
		"$(grep -q "ghcr.io/dockplanee/$image" "$release" && echo ok || echo fail)"
	check "$image is what the build script defaults to" \
		"$(grep -q "ghcr.io/dockplanee/$image" deploy/build-images.sh && echo ok || echo fail)"
done

# The tag is the one input a release build takes from outside. Expanding it in
# a shell would hand whoever can push a tag the ability to run commands here.
unsafe="$(awk '
	/^[[:space:]]*run:/ {
		inside = 1
		indent = match($0, /[^ ]/)
		if ($0 ~ /\$\{\{/) print FILENAME ":" FNR
		next
	}
	inside {
		if ($0 ~ /^[[:space:]]*$/) next
		if (match($0, /[^ ]/) <= indent) { inside = 0; next }
		if ($0 ~ /\$\{\{/) print FILENAME ":" FNR
	}
' "$ci" "$quality" "$release")"

check "no workflow expression is expanded inside a shell command" \
	"$([[ -z "$unsafe" ]] && echo ok || echo fail)"
[[ -n "$unsafe" ]] && printf '      %s\n' $unsafe

# A step's default shell has no pipefail, so a gate piped anywhere reports the
# status of whatever it was piped into. That is a gate that cannot fail.
unguarded="$(awk '
	/^[[:space:]]*run:/ {
		if (block != "" && block ~ /\| *tee/ && block !~ /pipefail/) print FILENAME ":" start
		inside = 1
		indent = match($0, /[^ ]/)
		start = FNR
		block = $0
		next
	}
	inside {
		if ($0 ~ /^[[:space:]]*$/) next
		if (match($0, /[^ ]/) <= indent) {
			if (block ~ /\| *tee/ && block !~ /pipefail/) print FILENAME ":" start
			inside = 0
			block = ""
			next
		}
		block = block "\n" $0
	}
	END {
		if (block ~ /\| *tee/ && block !~ /pipefail/) print FILENAME ":" start
	}
' "$ci" "$quality" "$release")"

check "no gate is piped without pipefail" \
	"$([[ -z "$unguarded" ]] && echo ok || echo fail)"
[[ -n "$unguarded" ]] && printf '      %s\n' $unguarded

# An action referenced by a moving name is an action somebody else can change
# after it was reviewed.
floating="$(grep -hoE "uses: [^ ]+@[^ ]+" "$ci" "$quality" "$release" |
	grep -vE "@[0-9a-f]{40}$" | grep -v "uses: \./" || true)"

check "every action is pinned to a commit" \
	"$([[ -z "$floating" ]] && echo ok || echo fail)"
[[ -n "$floating" ]] && printf '      %s\n' $floating

undocumented="$(grep -hoE "uses: [^ ]+@[0-9a-f]{40}( # v[0-9.]+)?" "$ci" "$quality" "$release" |
	grep -v " # v" || true)"

check "every pinned action records the version it was" \
	"$([[ -z "$undocumented" ]] && echo ok || echo fail)"
[[ -n "$undocumented" ]] && printf '      %s\n' "$undocumented"

check "container tools are pinned to a version" \
	"$(grep -hoE "(TRIVY_IMAGE|SHELLCHECK_IMAGE): '[^']+'" "$release" "$quality" |
		grep -qE ":latest'" && echo fail || echo ok)"

# --- the artefacts a release is made of --------------------------------------
echo
echo "release assets"

for asset in \
	'dockplane-\$VERSION.tar.gz' \
	'release-manifest.json' \
	'sbom-\*.json' \
	'dockplane-agent_\${debian_version}_amd64.deb' \
	'dockplane-agent_\${debian_version}_arm64.deb' \
	'dockplane-agent_\${VERSION}_linux_amd64.tar.gz' \
	'dockplane-agent_\${VERSION}_linux_arm64.tar.gz'; do
	check "the release carries $(echo "$asset" | tr -d '\\')" \
		"$(grep -qE "$asset" "$release" && echo ok || echo fail)"
done

check "the assets are checksummed" \
	"$(grep -q "sha256sum ./\* > SHA256SUMS" "$release" && echo ok || echo fail)"
check "the checksums are verified before anything is uploaded" \
	"$(grep -q "sha256sum -c SHA256SUMS" "$release" && echo ok || echo fail)"
check "a release candidate is published as a prerelease" \
	"$(grep -q -- "--prerelease" "$release" && echo ok || echo fail)"
check "the tag is verified to exist" \
	"$(grep -q -- "--verify-tag" "$release" && echo ok || echo fail)"

# Build output has no business in the history it was built from.
#
# Asked about a path inside the directory rather than the directory itself: an
# ignore rule written with a trailing slash matches only something that is a
# directory on disk, so asking about the bare name would answer "not ignored"
# in a checkout where nothing has been built — which is every checkout a build
# starts from.
for output in dist/release dist/agent app/dist api/dist; do
	ignored="$(git check-ignore -q "$output/anything" && echo yes || echo no)"
	tracked="$(git ls-files -- "$output")"

	check "$output is ignored and nothing in it is tracked" \
		"$([[ "$ignored" == yes && -z "$tracked" ]] && echo ok || echo fail)"
done

# --- the version a build refuses ---------------------------------------------
echo
echo "build inputs"

# A pre-release is a tilde in a Debian package, and a tilde is dangerous to
# produce: bash 5.2 and later expand one that appears in the replacement of a
# pattern substitution, so ${VERSION//-/~} silently becomes a home directory.
# That is invisible on a machine with an older bash and fatal on one without.
# This file is excluded because the pattern it looks for necessarily appears in
# it; nothing here converts a version.
tilde_substitution="$(grep -rln '//-/~' deploy .github --exclude=test-release.sh 2> /dev/null || true)"

check "no version is converted with a tilde a shell may expand" \
	"$([[ -z "$tilde_substitution" ]] && echo ok || echo fail)"
[[ -n "$tilde_substitution" ]] && printf '      %s\n' $tilde_substitution

for script in deploy/build-agent.sh deploy/check-agent-release.sh; do
	# Read by the line lifted out of the script below.
	# shellcheck disable=SC2034
	VERSION=0.1.0-rc.1
	eval "$(grep -m1 '^DEBIAN_VERSION=' "$script")"

	check "$(basename "$script") packages 0.1.0-rc.1 as 0.1.0~rc.1" \
		"$([[ "$DEBIAN_VERSION" == '0.1.0~rc.1' ]] && echo ok || echo fail)"
	unset DEBIAN_VERSION VERSION
done

bash deploy/build-agent.sh 1.2 > /dev/null 2>&1
check "the agent build refuses a version it cannot package" \
	"$([[ $? -eq 2 ]] && echo ok || echo fail)"

bash deploy/build-agent.sh > /dev/null 2>&1
check "the agent build refuses no version at all" "$([[ $? -eq 2 ]] && echo ok || echo fail)"

bash deploy/build-images.sh > /dev/null 2>&1
check "the image build refuses no version at all" "$([[ $? -eq 2 ]] && echo ok || echo fail)"

echo
if [[ "$failed" -eq 0 ]]; then
	printf '%s%d passed, 0 failed%s\n' "$GREEN" "$passed" "$RESET"
else
	printf '%s%d passed, %d failed%s\n' "$RED" "$passed" "$failed" "$RESET"
fi

[[ "$failed" -eq 0 ]]
