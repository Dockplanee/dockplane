#!/usr/bin/env bash
#
# Runs the installer's safety-backup gate against every way a backup can be
# wrong.
#
#   deploy/test-upgrade-gates.sh
#
# The gate exists because the installer once printed a backup it had not taken:
# the backup library is sourced by dockplane-control, and running it directly
# does nothing and exits zero. An exit status is not a backup, so the gate reads
# back what was written — and these are the cases that has to catch.
#
# Nothing here touches a real deployment. The backup command is a stub that
# produces exactly the failure under test, and the gate is lifted out of the
# installer and run against it.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$REPO_ROOT/deploy/install-control-plane.sh"

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

# The gate, exactly as the installer runs it. `fail` and the reporting helpers
# are replaced with something a test can observe.
harness() {
	cat <<-'PRELUDE'
		set -uo pipefail
		INSTALL_DIR="$HARNESS/install"
		SOURCE_DIR="$HARNESS/bundle"
		INSTALLED_VERSION=0.1.0-rc.1
		UPGRADE=1
		SAFETY_BACKUP=""
		BACKUP_FORMAT_VERSION=1
		MIGRATED=0

		step() { :; }
		info() { :; }
		good() { :; }
		note() { :; }
		fail() {
			printf 'BLOCKED: %s\n' "$1"
			exit 1
		}

		# Stands in for everything the upgrade would do next. If it runs, the
		# gate let something through.
		run_migrations() {
			MIGRATED=1
			printf 'MIGRATION RAN\n'
		}
	PRELUDE

	sed -n '/^safety_backup()/,/^}/p' "$INSTALLER"
	sed -n '/^verify_safety_backup()/,/^}/p' "$INSTALLER"

	cat <<-'EPILOGUE'
		safety_backup
		run_migrations
		printf 'COMPLETED\n'
	EPILOGUE
}

# Each case installs a `dockplane-control` that fails in one specific way.
run_case() {
	local name="$1" script="$2"
	local root="$work/$name"

	rm -rf "$root"
	mkdir -p "$root/install" "$root/bundle" "$root/backups"

	printf '#!/usr/bin/env bash\n%s\n' "$script" > "$root/install/dockplane-control"
	chmod +x "$root/install/dockplane-control"

	# The gate writes under /var/backups/dockplane; the stub is told where to
	# put things through the destination it is handed, and the root is
	# redirected so a test never writes outside its own directory.
	# The backup root is redirected into the test's own directory, and the
	# ownership the installer applies is dropped: it runs as root on a Linux host,
	# which preflight enforces, and this is about the gate rather than about who
	# owns a directory.
	local program="$work/$name.sh"
	harness |
		sed -e "s|local root=/var/backups/dockplane|local root=$root/backups|" \
			-e "s| -o root -g root||" > "$program"

	HARNESS="$root" bash "$program" 2>&1
}

# A backup that is exactly right, so the gate has something to accept.
complete_backup() {
	cat <<-'STUB'
		destination="$2"
		mkdir -p "$destination/secrets" "$destination/pki" "$destination/caddy"
		printf '{\n  "backupFormatVersion": 1,\n  "components": ["database"]\n}\n' > "$destination/manifest.json"
		printf 'dump\n' > "$destination/database.dump"
		printf 'DOCKPLANE_DOMAIN=example.test\n' > "$destination/env"
		printf 'key\n' > "$destination/secrets/application-encryption-key"
		printf 'ca\n' > "$destination/pki/agent-ca.key"
		(cd "$destination" && find . -type f ! -name SHA256SUMS -exec sha256sum {} + > SHA256SUMS)
		chmod 700 "$destination"
	STUB
}

echo
echo "==> a correct backup is accepted"

output="$(run_case accepted "$(complete_backup)")"
check "the upgrade continues" "$(grep -q COMPLETED <<< "$output" && echo ok || echo fail)"
check "the migration runs" "$(grep -q 'MIGRATION RAN' <<< "$output" && echo ok || echo fail)"

echo
echo "==> and every way it can be wrong stops the upgrade"

# Each of these must block, and none of them may reach the migration.
blocks() {
	local description="$1" name="$2" stub="$3"
	local output
	output="$(run_case "$name" "$stub")"

	check "$description" "$(grep -q BLOCKED <<< "$output" && echo ok || echo fail)"
	check "  ... and the migration did not run" \
		"$(grep -q 'MIGRATION RAN' <<< "$output" && echo fail || echo ok)"
}

blocks "the backup command fails" backup-fails 'exit 3'

# The original regression: success reported, nothing written.
blocks "the command succeeds but writes nothing" writes-nothing 'exit 0'

blocks "the manifest is missing" no-manifest "$(complete_backup)
rm -f \"\$2/manifest.json\""

blocks "the checksums are missing" no-checksums "$(complete_backup)
rm -f \"\$2/SHA256SUMS\""

blocks "the database dump is missing" no-dump "$(complete_backup)
rm -f \"\$2/database.dump\""

blocks "the environment file is missing" no-env "$(complete_backup)
rm -f \"\$2/env\""

blocks "the encryption key is missing" no-key "$(complete_backup)
rm -f \"\$2/secrets/application-encryption-key\""

blocks "the certificate authority is missing" no-ca "$(complete_backup)
rm -f \"\$2/pki/agent-ca.key\""

blocks "a checksum does not match" bad-checksum "$(complete_backup)
printf 'tampered\n' > \"\$2/database.dump\""

blocks "the format is one this release cannot restore" bad-format "$(complete_backup)
printf '{\n  \"backupFormatVersion\": 99\n}\n' > \"\$2/manifest.json\"
(cd \"\$2\" && find . -type f ! -name SHA256SUMS -exec sha256sum {} + > SHA256SUMS)"

blocks "the manifest does not say what format it is" no-format "$(complete_backup)
printf '{\n  \"components\": [\"database\"]\n}\n' > \"\$2/manifest.json\"
(cd \"\$2\" && find . -type f ! -name SHA256SUMS -exec sha256sum {} + > SHA256SUMS)"

blocks "the backup is readable by others" world-readable "$(complete_backup)
chmod 755 \"\$2\""

echo
if [[ "$failed" -eq 0 ]]; then
	printf '%s%d passed, 0 failed%s\n' "$GREEN" "$passed" "$RESET"
else
	printf '%s%d passed, %d failed%s\n' "$RED" "$passed" "$failed" "$RESET"
fi

[[ "$failed" -eq 0 ]]
