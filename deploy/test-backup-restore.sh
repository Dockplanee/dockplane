#!/usr/bin/env bash
#
# Checks what backup and restore refuse, and what a backup must contain.
#
#   deploy/test-backup-restore.sh
#
# A restore is the most destructive operation Dockplane has, and the properties
# that matter are the ones that stop it: a damaged backup, a missing key, a
# format from the future. Those are exercised here against fixtures, so the
# real disaster-recovery run is about whether it works rather than whether it
# checks.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULE="$REPO_ROOT/deploy/backup-restore.sh"
CONTROL="$REPO_ROOT/deploy/dockplane-control"

if [[ -t 1 ]]; then
	RED=$'\033[31m' GREEN=$'\033[32m' RESET=$'\033[0m'
else
	RED='' GREEN='' RESET=''
fi

passed=0
failed=0

check() {
	if [[ "$2" == "ok" ]]; then
		printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"
		passed=$((passed + 1))
	else
		printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"
		failed=$((failed + 1))
	fi
}

expect_output() {
	local description="$1" pattern="$2" output="$3"

	if grep -qiE "$pattern" <<< "$output"; then
		check "$description" ok
	else
		check "$description" fail
		sed 's/^/      /' <<< "$output" | head -5
	fi
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A backup that looks exactly like a real one, without needing a deployment to
# produce it. Restore reads these files and nothing else before it decides.
fixture() {
	local dir="$1" format="${2:-1}" schema="${3:-0004_audit_action_index}"

	mkdir -p "$dir/secrets" "$dir/pki"
	echo "dump" > "$dir/database.dump"

	for secret in postgres-password database-url application-encryption-key; do
		echo "value-of-$secret" > "$dir/secrets/$secret"
	done

	for material in agent-ca.crt agent-ca.key gateway.crt gateway.key; do
		echo "material-$material" > "$dir/pki/$material"
	done

	echo "DOCKPLANE_DOMAIN=dockplane.example.com" > "$dir/env"

	cat > "$dir/manifest.json" <<-JSON
		{
		  "backupFormatVersion": $format,
		  "createdAt": "2026-08-11T00:00:00Z",
		  "dockplaneVersion": "0.1.0",
		  "apiVersion": "0.1.0",
		  "schemaVersion": "$schema",
		  "protocolVersion": 1,
		  "domain": "dockplane.example.com",
		  "databaseFormat": "postgresql-custom",
		  "components": ["database", "secrets", "pki", "env"],
		  "excluded": ["caddy-acme-state", "live-log-streams", "managed-host-data"]
		}
	JSON

	(cd "$dir" && find . -type f ! -name SHA256SUMS -print0 | sort -z |
		xargs -0 shasum -a 256 2> /dev/null > SHA256SUMS ||
		find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
}

# validate_backup is the gate; it is called with the deployment's helpers
# stubbed out, because none of them are what is under test here.
validate_in() {
	local source="$1"

	INSTALL_DIR="$work/install" \
		bash -c '
		set -uo pipefail
		BOLD=""; RESET=""; RED=""
		ok() { printf "  ok %s\n" "$*"; }
		compose() { return 1; }
		setting() { echo ""; }
		. "'"$MODULE"'"
		validate_backup "'"$source"'"
	' 2>&1
}

echo "==> a complete backup is accepted"

fixture "$work/good"
output="$(validate_in "$work/good")"
expect_output "accepts a complete backup" "checksums match" "$output"
expect_output "reports the format it read" "format 1" "$output"
expect_output "confirms every component is there" "database, secrets and certificate authority are present" "$output"

echo
echo "==> a backup that cannot be trusted is refused"

fixture "$work/no-manifest" && rm "$work/no-manifest/manifest.json"
expect_output "refuses a backup with no manifest" "no manifest" "$(validate_in "$work/no-manifest")"

fixture "$work/no-sums" && rm "$work/no-sums/SHA256SUMS"
expect_output "refuses a backup with no checksums" "no checksums" "$(validate_in "$work/no-sums")"

fixture "$work/tampered" && echo "changed" > "$work/tampered/database.dump"
output="$(validate_in "$work/tampered")"
expect_output "refuses a backup whose contents changed" "checksums do not match" "$output"
expect_output "says nothing was restored" "nothing (has been changed|was restored)" "$output"

fixture "$work/no-key" && rm "$work/no-key/secrets/application-encryption-key"
output="$(validate_in "$work/no-key")"
expect_output "refuses a backup with no encryption key" "missing secrets/application-encryption-key" "$output"
expect_output "explains why that matters" "cannot restore a working deployment" "$output"

fixture "$work/no-ca" && rm "$work/no-ca/pki/agent-ca.key"
expect_output "refuses a backup with no certificate authority key" "missing pki/agent-ca.key" "$(validate_in "$work/no-ca")"

fixture "$work/no-db" && rm "$work/no-db/database.dump"
expect_output "refuses a backup with no database" "missing database.dump" "$(validate_in "$work/no-db")"

fixture "$work/future" 99
output="$(validate_in "$work/future")"
expect_output "refuses a format it does not understand" "format 99; this version understands up to" "$output"
expect_output "says which version to use instead" "newer dockplane" "$output"

mkdir -p "$work/empty"
expect_output "refuses a directory that is not a backup" "no manifest" "$(validate_in "$work/empty")"

expect_output "refuses a backup that does not exist" "no such backup" "$(validate_in "$work/nowhere")"

fixture "$work/unfinished.partial"
expect_output "refuses an unfinished backup" "unfinished backup" "$(validate_in "$work/unfinished.partial")"

echo
echo "==> what a backup must contain"

for required in database.dump secrets/application-encryption-key secrets/postgres-password \
	secrets/database-url pki/agent-ca.crt pki/agent-ca.key pki/gateway.crt pki/gateway.key env; do
	if grep -q "$required" "$MODULE"; then
		check "$required is required by validation" ok
	else
		check "$required is required by validation" fail
	fi
done

echo
echo "==> the manifest"

for field in backupFormatVersion createdAt dockplaneVersion apiVersion schemaVersion protocolVersion databaseFormat components; do
	if grep -q "\"$field\"" "$MODULE"; then
		check "the manifest records $field" ok
	else
		check "the manifest records $field" fail
	fi
done

# A manifest is written into the backup and read by whoever restores it. A
# secret in it would be a secret in a file nobody thinks of as one.
manifest_block="$(sed -n '/cat > "\$staging\/manifest.json"/,/^	JSON$/p' "$MODULE")"

for forbidden in 'postgres-password' 'application-encryption-key' 'agent-ca.key' 'PGPASSWORD'; do
	if grep -q "$forbidden" <<< "$manifest_block"; then
		check "the manifest carries no $forbidden" fail
	else
		check "the manifest carries no $forbidden" ok
	fi
done

# Caddy's certificates are optional: a backup without them still restores, and
# a backup with them saves a rebuild from asking Let's Encrypt again.
echo
echo "==> caddy certificates are optional"

fixture "$work/no-caddy"
expect_output "a backup without them is still valid" "checksums match" "$(validate_in "$work/no-caddy")"

if grep -q 'restore_caddy_state' "$MODULE" && grep -q 'return 0' <<< "$(sed -n '/^restore_caddy_state()/,/^}/p' "$MODULE")"; then
	check "restore skips them when they are absent" ok
else
	check "restore skips them when they are absent" fail
fi

if grep -qE 'caddy' <<< "$(sed -n '/for required in database.dump/,/done/p' "$MODULE")"; then
	check "they are not required" fail
else
	check "they are not required" ok
fi

echo
echo "==> secrets never become arguments"

# A password on a command line is readable by every user on the host through
# the process list, so it is read inside the container from the file it is
# already mounted as.
if grep -qE 'PGPASSWORD=\$\(cat /run/secrets/postgres-password\)' "$MODULE"; then
	check "the database password is read inside the container" ok
else
	check "the database password is read inside the container" fail
fi

if grep -qE '\-\-password|PGPASSWORD="?\$\{?[A-Za-z_]+\}?"?\s' "$MODULE"; then
	check "no password is passed on a command line" fail
else
	check "no password is passed on a command line" ok
fi

echo
echo "==> the restore policy"

policy="$(sed -n '/^apply_restore_policy()/,/^}/p' "$MODULE")"

expect_output "every session is revoked" "update sessions set revoked_at" "$policy"
expect_output "unused enrollment tokens are revoked" "update agent_enrollment_tokens set revoked_at" "$policy"
expect_output "only unused ones" "consumed_at is null" "$policy"
expect_output "unfinished actions are cancelled" "update actions set status = 'cancelled'" "$policy"
expect_output "only queued or running ones" "status in \('queued', 'running'\)" "$policy"

# Two failures found during disaster recovery, each of which produced a
# deployment that looked restored and was not.
echo
echo "==> the two failures disaster recovery found"

restore_block="$(sed -n '/^apply_restore()/,/^}/p' "$MODULE")"

# A dump carries tables, not roles. The password that works is the one the
# PostgreSQL being restored into was created with — on a rebuilt host, a new
# one. Restoring the backup's would leave .env pointing at a password the
# database does not have.
if grep -qE 'secrets/(postgres-password|database-url)"? +"\$INSTALL_DIR' <<< "$restore_block"; then
	check "the backup's database credentials are not made the live ones" fail
else
	check "the backup's database credentials are not made the live ones" ok
fi

if grep -q 'restore_in_place "$source/secrets/application-encryption-key"' <<< "$restore_block"; then
	check "the encryption key is the one secret that is restored" ok
else
	check "the encryption key is the one secret that is restored" fail
fi

# Compose bind-mounts a secret as a single file, which pins its inode. Writing
# a replacement file leaves every running container reading the old one — a
# server quietly using the wrong encryption key.
if grep -q 'cat "$from" > "$to"' "$MODULE"; then
	check "it is written through the existing file, not over it" ok
else
	check "it is written through the existing file, not over it" fail
fi

if grep -qE 'install -m 0400 .*secrets/application-encryption-key.*INSTALL_DIR' <<< "$restore_block"; then
	check "no replacement that would break the bind mount" fail
else
	check "no replacement that would break the bind mount" ok
fi

echo
echo "==> restore never regenerates the certificate authority"

if grep -qE 'setup-agent-ca' "$MODULE"; then
	check "restore does not run setup-agent-ca" fail
else
	check "restore does not run setup-agent-ca" ok
fi

if grep -qE 'install -m 0600 .*agent-ca\.key|for material in agent-ca\.key gateway\.key' "$MODULE"; then
	check "restore installs the authority from the backup" ok
else
	check "restore installs the authority from the backup" fail
fi

echo
echo "==> order of operations"

validate_line="$(grep -n 'validate_backup "\$source"' "$MODULE" | head -1 | cut -d: -f1)"
safety_line="$(grep -n '^	safety_backup$' "$MODULE" | head -1 | cut -d: -f1)"
apply_line="$(grep -n '^	apply_restore "\$source"' "$MODULE" | head -1 | cut -d: -f1)"

check "the backup is validated before anything else" \
	"$([[ -n "$validate_line" && -n "$safety_line" && "$validate_line" -lt "$safety_line" ]] && echo ok || echo fail)"
check "the current deployment is saved before it is replaced" \
	"$([[ -n "$safety_line" && -n "$apply_line" && "$safety_line" -lt "$apply_line" ]] && echo ok || echo fail)"

if grep -q 'fail_restore "could not back up the current deployment"' "$MODULE"; then
	check "a failed safety backup stops the restore" ok
else
	check "a failed safety backup stops the restore" fail
fi

echo
echo "==> a backup is only a backup when it is finished"

if grep -q 'staging="${target}.partial"' "$MODULE" && grep -q 'mv "$staging" "$target"' "$MODULE"; then
	check "it is assembled under .partial and renamed at the end" ok
else
	check "it is assembled under .partial and renamed at the end" fail
fi

if grep -q 'sha256sum -c SHA256SUMS' "$MODULE"; then
	check "its checksums are verified before it is named" ok
else
	check "its checksums are verified before it is named" fail
fi

for failure in 'the database could not be dumped' 'a secret or key could not be read' 'the checksums did not verify'; do
	if grep -q "$failure" "$MODULE"; then
		check "a failure to '$failure' removes the staging directory" ok
	else
		check "a failure to '$failure' removes the staging directory" fail
	fi
done

if grep -q 'refusing to write over' "$MODULE"; then
	check "it will not write over an existing backup" ok
else
	check "it will not write over an existing backup" fail
fi

echo
echo "==> permissions"

if grep -q 'umask 077' "$MODULE" && grep -q 'chmod 0700 "$staging"' "$MODULE"; then
	check "the backup is created readable only by its owner" ok
else
	check "the backup is created readable only by its owner" fail
fi

if grep -qE 'chmod 0600 "\$staging"/secrets/\* "\$staging"/pki/\*\.key' "$MODULE"; then
	check "keys inside it are owner-only" ok
else
	check "keys inside it are owner-only" fail
fi

echo
echo "==> confirmation"

if grep -q "read -r -p \"  Type 'restore' to continue: \" answer" "$MODULE"; then
	check "an interactive restore has to be typed out" ok
else
	check "an interactive restore has to be typed out" fail
fi

if grep -q 'refusing to restore without a terminal; pass --yes' "$MODULE"; then
	check "a non-interactive restore needs --yes" ok
else
	check "a non-interactive restore needs --yes" fail
fi

echo
echo "==> the control script"

bash -n "$CONTROL" && check "dockplane-control parses with the module" ok ||
	check "dockplane-control parses with the module" fail

# The usage text is only reachable from a directory that holds an installation.
touch "$work/compose.yaml"
output="$(DOCKPLANE_DIR="$work" bash "$CONTROL" 2>&1)"
expect_output "backup is offered" "backup <directory>" "$output"
expect_output "restore is offered" "restore <directory>" "$output"

echo
printf '%d passed, %d failed\n' "$passed" "$failed"
exit $((failed > 0 ? 1 : 0))
