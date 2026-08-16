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

# The release job no longer spells any of these out; it asks
# deploy/release-assets.sh, which is what the installer asks too.
for helper in bundle_name agent_package_name agent_tarball_name; do
	check "the release names its assets with $helper" \
		"$(grep -q "$helper" "$release" && echo ok || echo fail)"
done

check "the release carries the manifest" \
	"$(grep -q 'release-manifest.json' "$release" && echo ok || echo fail)"
check "the release carries the bills of materials" \
	"$(grep -q 'sbom-\*.json' "$release" && echo ok || echo fail)"
check "both architectures are published" \
	"$(grep -q 'for arch in amd64 arm64' "$release" && echo ok || echo fail)"

check "the assets are checksummed under the names they are published as" \
	"$(grep -q "sha256sum ./\* | sed" "$release" && echo ok || echo fail)"
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
	check "$(basename "$script") takes the Debian version from one place" \
		"$(grep -q 'DEBIAN_VERSION="$(debian_version "$VERSION")"' "$script" && echo ok || echo fail)"
done

bash deploy/build-agent.sh 1.2 > /dev/null 2>&1
check "the agent build refuses a version it cannot package" \
	"$([[ $? -eq 2 ]] && echo ok || echo fail)"

bash deploy/build-agent.sh > /dev/null 2>&1
check "the agent build refuses no version at all" "$([[ $? -eq 2 ]] && echo ok || echo fail)"

bash deploy/build-images.sh > /dev/null 2>&1
check "the image build refuses no version at all" "$([[ $? -eq 2 ]] && echo ok || echo fail)"

# --- Release asset names ----------------------------------------------------
#
# 0.1.0-rc.2 published a package as dockplane-agent_0.1.0.rc.2_amd64.deb while
# the installer asked for dockplane-agent_0.1.0~rc.2_amd64.deb: GitHub rewrites
# a tilde in an asset name to a full stop, and the download 404'd. The tilde
# belongs in the package's Version field, which is not a file name.

echo
echo "==> release asset names"

# shellcheck source=deploy/release-assets.sh
source "$REPO_ROOT/deploy/release-assets.sh"

check "the Debian version keeps the tilde dpkg orders by" \
	"$([[ "$(debian_version 0.1.0-rc.3)" == '0.1.0~rc.3' ]] && echo ok || echo fail)"
check "a final release has no tilde to keep" \
	"$([[ "$(debian_version 0.1.0)" == '0.1.0' ]] && echo ok || echo fail)"

check "the package file is named for the product version" \
	"$([[ "$(agent_package_name 0.1.0-rc.3 amd64)" == 'dockplane-agent_0.1.0-rc.3_amd64.deb' ]] && echo ok || echo fail)"
check "the tarball is named for the product version" \
	"$([[ "$(agent_tarball_name 0.1.0-rc.3 arm64)" == 'dockplane-agent_0.1.0-rc.3_linux_arm64.tar.gz' ]] && echo ok || echo fail)"
check "the bundle is named for the product version" \
	"$([[ "$(bundle_name 0.1.0-rc.3)" == 'dockplane-0.1.0-rc.3.tar.gz' ]] && echo ok || echo fail)"

# The regression itself: no published name may carry a character GitHub rewrites.
tilde_names=""
for name in $(release_asset_names 0.1.0-rc.3 amd64 arm64); do
	[[ "$name" == *"~"* ]] && tilde_names+="$name "
	assert_publishable "$name" 2> /dev/null || tilde_names+="$name "
done

check "no published asset name contains a character GitHub would rewrite" \
	"$([[ -z "$tilde_names" ]] && echo ok || echo fail)"
[[ -n "$tilde_names" ]] && printf '      %s\n' $tilde_names

check "a name with a tilde is refused outright" \
	"$(assert_publishable 'dockplane-agent_0.1.0~rc.3_amd64.deb' 2> /dev/null && echo fail || echo ok)"
check "a name with a space is refused" \
	"$(assert_publishable 'a b.deb' 2> /dev/null && echo fail || echo ok)"

# Every component has to agree, or the one that disagrees is the one nobody ran.
check "the build script composes no asset name of its own" \
	"$(grep -qE '"dockplane-agent_\$\{?(VERSION|DEBIAN_VERSION)' "$REPO_ROOT/deploy/build-agent.sh" && echo fail || echo ok)"
check "the release checks compose no asset name of their own" \
	"$(grep -qE '"dockplane-agent_\$\{?(VERSION|DEBIAN_VERSION)' "$REPO_ROOT/deploy/check-agent-release.sh" && echo fail || echo ok)"
check "the workflow composes no asset name of its own" \
	"$(grep -qE 'dockplane-agent_\$\{(debian_version|VERSION)\}' "$REPO_ROOT/.github/workflows/release.yml" && echo fail || echo ok)"
check "the workflow refuses a name GitHub would rewrite" \
	"$(grep -q 'assert_publishable' "$REPO_ROOT/.github/workflows/release.yml" && echo ok || echo fail)"

# The installer the control plane serves has to ask for what was published.
check "the bootstrap installer requests the product-version package" \
	"$(grep -q 'package="dockplane-agent_\\\${AGENT_VERSION}_\\\${ARCH}.deb"' "$REPO_ROOT/api/src/host-setup/install-script.ts" && echo ok || echo fail)"
check "the bootstrap installer no longer builds a Debian-version file name" \
	"$(grep -q 'PACKAGE_VERSION' "$REPO_ROOT/api/src/host-setup/install-script.ts" && echo fail || echo ok)"

# --- Publishing in two steps ------------------------------------------------
#
# 0.1.0-rc.2 was a public release candidate whose agent package could not be
# downloaded. It was public the moment it was created, so there was no point at
# which anything could have looked and said no. There is one now.

check "the release is created as a draft" \
	"$(grep -q -- '--draft' "$release" && echo ok || echo fail)"
check "what GitHub accepted is fetched back" \
	"$(grep -q 'Accept: application/octet-stream' "$release" && echo ok || echo fail)"
check "the fetched assets are verified" \
	"$(grep -q 'verify-release-assets.sh' "$release" && echo ok || echo fail)"
check "the draft is promoted rather than replaced" \
	"$(grep -q 'gh release edit "\$TAG"' "$release" && echo ok || echo fail)"
check "only one release is ever created" \
	"$([[ "$(grep -c 'gh release create' "$release")" == "1" ]] && echo ok || echo fail)"

order_in_release() { grep -n "$1" "$release" | tail -1 | cut -d: -f1; }

check "verification comes before publication" \
	"$([[ "$(order_in_release 'verify-release-assets.sh')" -lt "$(order_in_release 'gh release edit')" ]] && echo ok || echo fail)"
check "the assets are fetched back before they are verified" \
	"$([[ "$(order_in_release 'Accept: application/octet-stream')" -lt "$(order_in_release 'verify-release-assets.sh')" ]] && echo ok || echo fail)"
check "the public download is checked after publication" \
	"$([[ "$(order_in_release 'releases/download')" -gt "$(order_in_release 'gh release edit')" ]] && echo ok || echo fail)"
check "the public check uses no token" \
	"$(sed -n "$(order_in_release 'Check the public download'),\$p" "$release" | grep -q 'GH_TOKEN' && echo fail || echo ok)"
check "the expected list is not written out in the workflow" \
	"$(grep -q 'source deploy/release-assets.sh' "$release" && echo ok || echo fail)"
check "only the release job may write contents" \
	"$([[ "$(grep -c 'contents: write' "$release")" == "1" ]] && echo ok || echo fail)"

# --- a gate cannot pass on a shell it cannot run on -------------------------
#
# Some gates are written against bash 4. Run by the bash 3.2 that macOS ships,
# the constructs they are built on fail, every check goes missing, and the run
# ends with nothing reported and a status of zero. That is the same defect as a
# gate skipping a check because a tool is absent, one level further down.
echo
echo "shells a gate refuses to run on"

# The scripts whose checks are built on a bash 4 construct. This file names
# those constructs and would otherwise find itself.
needs_bash4() {
	grep -lE 'declare -A |mapfile |readarray ' deploy/*.sh 2> /dev/null |
		grep -v "$(basename "${BASH_SOURCE[0]}")"
}

guarded="$(needs_bash4)"

check "some gate declares a dependency on bash 4" \
	"$([[ -n "$guarded" ]] && echo ok || echo fail)"

# An interpreter old enough to lack those constructs. macOS keeps one at
# /bin/bash; a machine that ships only bash 5 has nothing to run this on, and
# says so rather than counting a check it did not make.
old_bash=""
for candidate in /bin/bash /usr/bin/bash; do
	[[ -x "$candidate" ]] || continue
	version="$("$candidate" -c 'echo ${BASH_VERSINFO[0]}' 2> /dev/null)"
	if [[ -n "$version" && "$version" -lt 4 ]]; then
		old_bash="$candidate"
		break
	fi
done

while read -r script; do
	[[ -n "$script" ]] || continue

	# The refusal has to come before anything is reported, so grep for it in
	# the part of the file that precedes the first check.
	preamble="$(sed -n '1,/^check()/p' "$script")"
	check "$(basename "$script") refuses an unsupported shell before checking" \
		"$(grep -q 'needs bash 4 or newer' <<< "$preamble" && echo ok || echo fail)"
	check "$(basename "$script") leaves with a non-zero status when it refuses" \
		"$(grep -qE 'exit [1-9]' <<< "$preamble" && echo ok || echo fail)"

	if [[ -n "$old_bash" ]]; then
		output="$("$old_bash" "$script" 2> /dev/null)"
		status=$?

		check "$(basename "$script") fails under $("$old_bash" -c 'echo $BASH_VERSION')" \
			"$([[ "$status" -ne 0 ]] && echo ok || echo fail)"
		check "$(basename "$script") reports no result it did not produce" \
			"$(grep -q '✓' <<< "$output" && echo fail || echo ok)"
	fi
done <<< "$guarded"

if [[ -z "$old_bash" ]]; then
	echo "  no bash older than 4 on this machine; the refusal was read, not run"
fi

# --- a gate cannot measure a fixture the daemon never received --------------
#
# The same defect one layer along. A bind mount names a path and the daemon
# resolves it in its own filesystem, so a suite running inside a container that
# uses the host's socket has its fixture replaced by an empty directory the
# daemon creates. The measurement then succeeds on nothing: the reproducibility
# gate reported a payload of 1 kilobyte and three failures of a rule that was
# never exercised.
echo
echo "fixtures a gate refuses to measure"

visible=deploy/fixture-visible.sh

check "the fixture precondition exists and is executable" \
	"$([[ -x "$visible" ]] && echo ok || echo fail)"

check "the reproducibility gate asks it before measuring" \
	"$(grep -q 'fixture-visible.sh' deploy/test-reproducibility.sh && echo ok || echo fail)"

if ! command -v docker > /dev/null; then
	# This file's check takes the description first. Written the other way
	# round, the refusal still counted as one — and printed "fail" where the
	# reason belonged, which is the one moment the reason is worth having.
	check "docker is available to prove what the daemon sees" fail
else
	prepared="$work/fixture"
	mkdir -p "$prepared/usr/bin"
	head -c 16 /dev/zero > "$prepared/usr/bin/payload"

	"$visible" "$prepared" > /dev/null 2>&1
	check "a fixture the daemon can read is accepted" \
		"$([[ $? -eq 0 ]] && echo ok || echo fail)"

	"$visible" "$work/never-created" > /dev/null 2>&1
	check "a fixture that does not exist is refused" \
		"$([[ $? -ne 0 ]] && echo ok || echo fail)"

	# What the daemon leaves behind when it cannot find the path: an empty
	# directory, which measures as a valid number and means nothing.
	mkdir -p "$work/substituted"
	"$visible" "$work/substituted" > /dev/null 2>&1
	check "an empty stand-in for a fixture is refused" \
		"$([[ $? -ne 0 ]] && echo ok || echo fail)"

	# And it has to look at the contents rather than at the path, or the
	# substitution it exists to catch would pass.
	check "it compares what is there, not where it is" \
		"$(grep -qE "find \.|find /tree" "$visible" && echo ok || echo fail)"
fi

echo
if [[ "$failed" -eq 0 ]]; then
	printf '%s%d passed, 0 failed%s\n' "$GREEN" "$passed" "$RESET"
else
	printf '%s%d passed, %d failed%s\n' "$RED" "$passed" "$failed" "$RESET"
fi

[[ "$failed" -eq 0 ]]
