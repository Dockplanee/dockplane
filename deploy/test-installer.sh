#!/usr/bin/env bash
#
# Checks what the installer refuses to do, and what it refuses to destroy.
#
#   deploy/test-installer.sh
#
# The interesting behaviour of an installer is mostly negative: the hosts it
# declines to touch, and the material it will not replace on a second run.
# Those are the cases that are expensive to discover on somebody's server, so
# they are exercised here against a fake environment rather than a real one.

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

expect_output() {
	local description="$1" pattern="$2" output="$3"

	if grep -qiE "$pattern" <<< "$output"; then
		check "$description" ok
	else
		check "$description" fail
		printf '      wanted /%s/ in:\n' "$pattern"
		sed 's/^/      /' <<< "$output" | head -6
	fi
}

# Replaces one command in the scaffold. The entry is removed first: writing
# over a symlink would write through it to the real binary.
shim() {
	local path="$1"
	rm -f "$path"
	cat > "$path"
	chmod +x "$path"
}

root_shim() {
	shim "$1/bin/id" <<'EOF'
#!/bin/sh
[ "$1" = "-u" ] && echo 0 || exec /usr/bin/id "$@"
EOF
}

# A directory that stands in for the host: a fake /etc/os-release, fake
# commands on PATH, and a temporary install directory. Nothing here touches the
# machine running the tests.
scaffold() {
	local dir="$1" os="${2:-ubuntu}" version="${3:-24.04}"

	mkdir -p "$dir/bin" "$dir/etc" "$dir/root"
	printf 'ID=%s\nVERSION_ID="%s"\n' "$os" "$version" > "$dir/etc/os-release"


	for command in bash sh docker openssl awk sed grep stat df id uname install date curl tr head sort cut \
		cat chmod mkdir rm ln printf dirname basename wc seq base64 getent ip ss; do
		local real
		real="$(command -v "$command" 2> /dev/null || true)"
		[[ -n "$real" ]] && ln -sf "$real" "$dir/bin/$command"
	done

	# The scaffold is a Linux host regardless of what is running the tests.
	shim "$dir/bin/uname" <<'EOF'
#!/bin/sh
[ "$1" = "-m" ] && echo x86_64 || exec /usr/bin/uname "$@"
EOF
}

# The installer reads /etc/os-release directly, so the fake one is bind-mounted
# in the only way available without root: by running the installer with a
# rewritten copy of itself.
installer_with() {
	local dir="$1"
	shift

	sed "s#/etc/os-release#$dir/etc/os-release#g" "$INSTALLER" > "$dir/install.sh"
	chmod +x "$dir/install.sh"

	# ISOLATED hides everything outside the scaffold, which is how a command
	# that is genuinely absent is simulated.
	if [[ "${ISOLATED:-0}" == "1" ]]; then
		PATH="$dir/bin" "$dir/bin/bash" "$dir/install.sh" "$@" 2>&1
	else
		PATH="$dir/bin:$PATH" bash "$dir/install.sh" "$@" 2>&1
	fi
}

echo "==> refusals"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --- not root ---------------------------------------------------------------
scaffold "$work/notroot"
shim "$work/notroot/bin/id" <<'EOF'
#!/bin/sh
[ "$1" = "-u" ] && echo 1000 || exec /usr/bin/id "$@"
EOF
output="$(installer_with "$work/notroot" --domain dockplane.example.com --dir "$work/notroot/opt" --yes)"
expect_output "refuses to run without root" "must run as root" "$output"
check "writes nothing without root" "$([[ ! -d "$work/notroot/opt" ]] && echo ok || echo fail)"

# --- unsupported operating system -------------------------------------------
scaffold "$work/fedora" fedora 41
root_shim "$work/fedora"
output="$(installer_with "$work/fedora" --domain dockplane.example.com --dir "$work/fedora/opt" --yes)"
expect_output "refuses an unsupported operating system" "unsupported operating system" "$output"
expect_output "names the systems it does support" "ubuntu 24.04 and debian 12" "$output"
check "writes nothing on an unsupported system" "$([[ ! -d "$work/fedora/opt" ]] && echo ok || echo fail)"

# --- Docker missing ---------------------------------------------------------
scaffold "$work/nodocker"
rm -f "$work/nodocker/bin/docker"
root_shim "$work/nodocker"
output="$(ISOLATED=1 installer_with "$work/nodocker" --domain dockplane.example.com --dir "$work/nodocker/opt" --yes)"
expect_output "refuses when Docker is missing" "missing commands.*docker|docker" "$output"
check "writes nothing when Docker is missing" "$([[ ! -d "$work/nodocker/opt" ]] && echo ok || echo fail)"

# --- Compose plugin missing -------------------------------------------------
scaffold "$work/nocompose"
shim "$work/nocompose/bin/docker" <<'EOF'
#!/bin/sh
case "$1" in
  compose) exit 1 ;;
  --version) echo "Docker version 29.0.0, build test" ;;
  info) exit 0 ;;
  *) exit 0 ;;
esac
EOF
root_shim "$work/nocompose"

output="$(installer_with "$work/nocompose" --domain dockplane.example.com --dir "$work/nocompose/opt" --yes)"
expect_output "refuses without the Compose plugin" "compose plugin is not available" "$output"
expect_output "says where to get it" "docker-compose-plugin" "$output"

# --- Docker daemon down -----------------------------------------------------
scaffold "$work/nodaemon"
shim "$work/nodaemon/bin/docker" <<'EOF'
#!/bin/sh
case "$1" in
  compose) [ "$2" = "version" ] && { echo "v5.0.0"; exit 0; } ; exit 0 ;;
  --version) echo "Docker version 29.0.0, build test" ;;
  info) exit 1 ;;
  *) exit 0 ;;
esac
EOF
root_shim "$work/nodaemon"

output="$(installer_with "$work/nodaemon" --domain dockplane.example.com --dir "$work/nodaemon/opt" --yes)"
expect_output "refuses when the daemon is not reachable" "daemon is not reachable" "$output"

# --- invalid domain ---------------------------------------------------------
scaffold "$work/domain"
root_shim "$work/domain"

for bad_domain in "https://dockplane.example.com" "dockplane" "not a domain" "-leading.example.com"; do
	output="$(installer_with "$work/domain" --domain "$bad_domain" --dir "$work/domain/opt" --yes)"
	expect_output "refuses the hostname '$bad_domain'" "not a valid hostname" "$output"
done

# --- a port already in use --------------------------------------------------
#
# The installer must say which port and stop. Taking a port from another
# service is not a decision an installer gets to make.
scaffold "$work/ports"
root_shim "$work/ports"
shim "$work/ports/bin/docker" <<'EOF'
#!/bin/sh
case "$1" in
  compose) [ "$2" = "version" ] && { echo "v5.0.0"; exit 0; } ; exit 0 ;;
  --version) echo "Docker version 29.0.0, build test" ;;
  info) exit 0 ;;
  *) exit 0 ;;
esac
EOF
shim "$work/ports/bin/ss" <<'EOF'
#!/bin/sh
case "$*" in
  *":443"*) echo 'LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=1,fd=6))' ;;
esac
EOF
output="$(installer_with "$work/ports" --domain dockplane.example.com --dir "$work/ports/opt" --yes)"
expect_output "refuses when a required port is in use" "already in use" "$output"
expect_output "names the port that is taken" "443" "$output"
expect_output "names what is holding it" "nginx" "$output"
expect_output "does not offer to stop it" "will not stop another service" "$output"
check "writes nothing when a port is taken" "$([[ ! -d "$work/ports/opt" ]] && echo ok || echo fail)"

echo
echo "==> secrets"

# The generators are the part that must not be weakened, so they are exercised
# directly rather than through a whole installation.
eval "$(sed -n '/^random_password()/,/^}/p;/^random_key()/,/^}/p' "$INSTALLER")"

password="$(random_password)"
check "the generated password is 32 characters" "$([[ ${#password} -eq 32 ]] && echo ok || echo fail)"
check "the generated password is alphanumeric" "$([[ "$password" =~ ^[A-Za-z0-9]{32}$ ]] && echo ok || echo fail)"

second="$(random_password)"
check "two passwords differ" "$([[ "$password" != "$second" ]] && echo ok || echo fail)"

key="$(random_key)"
decoded="$(printf '%s' "$key" | base64 -d 2> /dev/null | wc -c | tr -d ' ')"
check "the encryption key is 32 bytes" "$([[ "$decoded" -eq 32 ]] && echo ok || echo fail)"
check "two keys differ" "$([[ "$key" != "$(random_key)" ]] && echo ok || echo fail)"

# Distinct across many draws: a generator seeded from the clock or the process
# id would repeat here.
distinct="$(for _ in $(seq 1 20); do random_password; echo; done | sort -u | wc -l | tr -d ' ')"
check "twenty passwords are all different" "$([[ "$distinct" -eq 20 ]] && echo ok || echo fail)"

echo
echo "==> a second run keeps what exists"

# generate_secret_file is what stands between a re-run and a deployment that
# can no longer read its own database.
state="$work/state"
mkdir -p "$state"

eval "$(sed -n '/^generate_secret_file()/,/^}/p' "$INSTALLER")"
# Read by the function lifted out of the installer above.
# shellcheck disable=SC2034
SERVICE_UID="$(id -u)"
# shellcheck disable=SC2034
SERVICE_GID="$(id -g)"
note() { :; }
good() { :; }

printf 'an-existing-secret' > "$state/postgres-password"
before="$(cat "$state/postgres-password")"
generate_secret_file "$state/postgres-password" random_password "database password" > /dev/null 2>&1
check "an existing password is not replaced" "$([[ "$(cat "$state/postgres-password")" == "$before" ]] && echo ok || echo fail)"

generate_secret_file "$state/new-secret" random_password "a new secret" > /dev/null 2>&1
check "a missing secret is created" "$([[ -s "$state/new-secret" ]] && echo ok || echo fail)"
check "a new secret is owner-read-only" "$([[ "$(stat -c '%a' "$state/new-secret" 2> /dev/null || stat -f '%Lp' "$state/new-secret")" == "400" ]] && echo ok || echo fail)"

# An installer started from a pipe or a heredoc must not have its own script
# eaten by a command that reads standard input.
echo
echo "==> standard input"

for call in 'up -d postgres' 'run --rm migrate' 'up -d$'; do
	if grep -qE "quiet_compose $call" "$INSTALLER"; then
		check "'compose $call' is given nothing to read" ok
	else
		check "'compose $call' is given nothing to read" fail
	fi
done

# The one call that must keep it: the administrator's password is typed in.
# Typed in: keeps the terminal. Read from a file: given nothing, so an
# installer running from a pipe does not have its own input eaten.
bootstrap_block="$(sed -n '/^run_bootstrap()/,/^}/p' "$INSTALLER")"

if grep -qE 'dist/cli/bootstrap-admin.js .*< /dev/null' <<< "$bootstrap_block" &&
	grep -cE 'dist/cli/bootstrap-admin.js' <<< "$bootstrap_block" | grep -q 2; then
	check "the unattended path is given nothing to read" ok
else
	check "the unattended path is given nothing to read" fail
fi

if grep -qE 'dist/cli/bootstrap-admin.js "\$ADMIN_EMAIL" "\$\{DISPLAY_NAME:-\$ADMIN_EMAIL\}"$' <<< "$bootstrap_block"; then
	check "the interactive prompt keeps its terminal" ok
else
	check "the interactive prompt keeps its terminal" fail
fi

# An unattended installation still must not put the password in the container's
# configuration, where `docker inspect` would show it.
if grep -q 'DOCKPLANE_BOOTSTRAP_PASSWORD_FILE=/run/bootstrap-password' "$INSTALLER" &&
	! grep -qE '\-e DOCKPLANE_BOOTSTRAP_PASSWORD=' "$INSTALLER"; then
	check "an unattended password is mounted, not put in the environment" ok
else
	check "an unattended password is mounted, not put in the environment" fail
fi

# A RETURN trap that names a local runs after that local is gone. Under
# `set -u` it fails, and an installation that had just succeeded exits
# non-zero — found on a real installation, where the summary printed and the
# script then reported an error.
echo
echo "==> cleanup that cannot fail after the work is done"

if grep -qE "trap .* RETURN" "$INSTALLER"; then
	check "no RETURN trap referring to a local" fail
else
	check "no RETURN trap referring to a local" ok
fi

if grep -q 'discard_handover' "$INSTALLER" && grep -q 'rm -f "$HANDOVER"' "$INSTALLER"; then
	check "the password copy is removed explicitly" ok
else
	check "the password copy is removed explicitly" fail
fi

# Removed on the failure path as well as the success path.
handover_removals="$(grep -c 'discard_handover' "$INSTALLER")"
[[ "$handover_removals" -ge 3 ]] && check "removed on both the success and failure paths" ok ||
	check "removed on both the success and failure paths" fail

echo
echo "==> the installer never destroys data"

for pattern in 'down .*-v' 'down .*--volumes' 'rm -rf /var/lib/docker' 'volume rm' 'DROP DATABASE'; do
	if grep -qE "$pattern" "$INSTALLER"; then
		check "does not contain '$pattern'" fail
	else
		check "does not contain '$pattern'" ok
	fi
done

# The state marker is written after the stack is serving, so a failed run
# cannot leave something that claims to be finished.
marker_line="$(grep -n 'record_state' "$INSTALLER" | tail -1 | cut -d: -f1)"
start_line="$(grep -n 'start_stack$' "$INSTALLER" | tail -1 | cut -d: -f1)"
check "the installed marker is written only after the stack starts" \
	"$([[ "$marker_line" -gt "$start_line" ]] && echo ok || echo fail)"

echo
echo "==> the operations helper"

CONTROL="$REPO_ROOT/deploy/dockplane-control"
bash -n "$CONTROL" && check "dockplane-control parses" ok || check "dockplane-control parses" fail

output="$(DOCKPLANE_DIR="$work" bash "$CONTROL" status 2>&1)"
expect_output "refuses to act on a directory with no installation" "no dockplane installation" "$output"

# The usage text explains what "down --volumes" would do, so the check looks at
# what the script executes rather than at what it says.
executable="$(awk '/<<-?EOF/{inside=1} !inside; /^[[:space:]]*EOF[[:space:]]*$/{inside=0}' "$CONTROL")"

for pattern in 'down .*-v' 'down .*--volumes' 'volume rm'; do
	if grep -qE "^[^#]*$pattern" <<< "$executable"; then
		check "dockplane-control does not run '$pattern'" fail
	else
		check "dockplane-control does not run '$pattern'" ok
	fi
done

# --- Upgrading --------------------------------------------------------------
#
# The version an upgrade installs comes from the bundle it was started from.
# Reading it from the installed deployment instead is how an upgrade goes
# looking for the release it is meant to be replacing.

echo
echo "==> upgrading"

installer="$(cat "$INSTALLER")"

eval "$(sed -n '/^bundle_version()/,/^}/p' "$INSTALLER")"
eval "$(sed -n '/^installed_version()/,/^}/p' "$INSTALLER")"
eval "$(sed -n '/^compare_versions()/,/^}/p' "$INSTALLER")"

upgrade_work="$(mktemp -d)"
trap 'rm -rf "$upgrade_work"' EXIT

mkdir -p "$upgrade_work/bundle"
printf '{\n  "version": "0.1.0-rc.2",\n  "commit": "abc"\n}\n' > "$upgrade_work/bundle/release-manifest.json"

SOURCE_DIR="$upgrade_work/bundle"
check "the target version comes from the bundle manifest" \
	"$([[ "$(bundle_version)" == "0.1.0-rc.2" ]] && echo ok || echo fail)"

SOURCE_DIR="$upgrade_work/no-bundle"
check "a checkout without a manifest names no version" \
	"$(bundle_version > /dev/null 2>&1 && echo fail || echo ok)"

mkdir -p "$upgrade_work/installed"
printf 'version=0.1.0-rc.1\ndomain=example.test\n' > "$upgrade_work/installed/version"
STATE_FILE="$upgrade_work/installed/version"
check "the installed version comes from the deployment" \
	"$([[ "$(installed_version)" == "0.1.0-rc.1" ]] && echo ok || echo fail)"

STATE_FILE="$upgrade_work/absent/version"
check "a fresh machine reports no installed version" \
	"$(installed_version > /dev/null 2>&1 && echo fail || echo ok)"

# Ordering decides whether something is an upgrade, a repair or a downgrade, so
# releases are compared the way releases are ordered rather than as strings.
orders() {
	local relation="is older than"
	[[ "$3" == 1 ]] && relation="is newer than"
	[[ "$3" == 0 ]] && relation="is"

	check "$1 $relation $2" "$([[ "$(compare_versions "$1" "$2")" == "$3" ]] && echo ok || echo fail)"
}

orders 0.1.0-rc.2 0.1.0-rc.1 1
orders 0.1.0-rc.1 0.1.0-rc.2 -1
orders 0.1.0-rc.1 0.1.0-rc.1 0
orders 0.1.0 0.1.0-rc.9 1
orders 0.1.0-rc.9 0.1.0 -1
orders 0.1.0-rc.10 0.1.0-rc.9 1
orders 0.10.0 0.2.0 1
orders 1.0.0 0.9.9 1
orders 0.1.0-beta.1 0.1.0-rc.1 -1

check "the deployment's own files are staged from the bundle" \
	"$(grep -q 'compose/compose.yaml" "$INSTALL_DIR/compose.yaml.staged"' <<< "$installer" && echo ok || echo fail)"
check "they are adopted only once Compose renders them" \
	"$(grep -q 'mv "$INSTALL_DIR/compose.yaml.staged" "$INSTALL_DIR/compose.yaml"' <<< "$installer" && echo ok || echo fail)"
check "the previous ones are kept" \
	"$(grep -q 'compose.yaml.pre-upgrade' <<< "$installer" && echo ok || echo fail)"
check "a backup is taken before an upgrade" \
	"$(grep -q 'safety_backup' <<< "$installer" && echo ok || echo fail)"
check "a failed backup stops the upgrade" \
	"$(grep -q 'the pre-upgrade backup failed' <<< "$installer" && echo ok || echo fail)"
check "a downgrade is refused" \
	"$(grep -q 'this bundle is older than what is installed' <<< "$installer" && echo ok || echo fail)"
check "artefacts are named with the target version" \
	"$(grep -q 'TARGET_VERSION="$VERSION"' <<< "$installer" && echo ok || echo fail)"
check "the version marker records the target version" \
	"$(grep -q 'version=$TARGET_VERSION' <<< "$installer" && echo ok || echo fail)"
check "an operator's settings are amended rather than replaced" \
	"$(grep -q 'ensure_setting' <<< "$installer" && echo ok || echo fail)"
check "no secret is regenerated on an upgrade" \
	"$(grep -q 'already exists, keeping it' <<< "$installer" && echo ok || echo fail)"

# The backup is the one thing that makes an upgrade reversible, and it reported
# success once while writing nothing: backup-restore.sh is a library that
# dockplane-control sources, and running it directly does nothing and exits
# zero. An exit status is not a backup.
check "the backup goes through dockplane-control, not the library" \
	"$(grep -q 'bash "$helper" backup' <<< "$installer" && echo ok || echo fail)"
check "backup-restore.sh is never executed directly" \
	"$(grep -qE '(bash |")\$?\{?(SOURCE_DIR|INSTALL_DIR)\}?/backup-restore\.sh" backup' <<< "$installer" && echo fail || echo ok)"
check "what was written is read back before the upgrade continues" \
	"$(grep -q 'verify_safety_backup' <<< "$installer" && echo ok || echo fail)"
check "a backup that wrote nothing stops the upgrade" \
	"$(grep -q 'reported success but wrote nothing' <<< "$installer" && echo ok || echo fail)"
check "a missing component stops the upgrade" \
	"$(grep -q 'the backup is incomplete' <<< "$installer" && echo ok || echo fail)"
check "the checksums are verified" \
	"$(grep -q 'does not match its own checksums' <<< "$installer" && echo ok || echo fail)"
check "the manifest is read" \
	"$(grep -q 'the backup manifest does not say what format it is' <<< "$installer" && echo ok || echo fail)"
check "the backup directory must be owner-only" \
	"$(grep -q 'readable by others' <<< "$installer" && echo ok || echo fail)"
check "backups are kept outside the deployment directory" \
	"$(grep -q 'local root=/var/backups/dockplane' <<< "$installer" && echo ok || echo fail)"
check "the backup is taken before the schema is migrated" \
	"$([[ "$(grep -n 'safety_backup$' <<< "$installer" | tail -1 | cut -d: -f1)" -lt "$(grep -n 'write_configuration$' <<< "$installer" | tail -1 | cut -d: -f1)" ]] && echo ok || echo fail)"
check "a fresh install takes no pre-upgrade backup" \
	"$(grep -q '\[\[ "\$UPGRADE" -eq 1 \]\] || return 0' <<< "$installer" && echo ok || echo fail)"
check "the path is named again at the end" \
	"$(grep -q 'Safety backup from this upgrade' <<< "$installer" && echo ok || echo fail)"

check "the backup format is checked against what this release restores" \
	"$(grep -q 'this backup is in a format this release does not restore' <<< "$installer" && echo ok || echo fail)"
check "the installer and the backup library agree on the format version" \
	"$([[ "$(grep -oE '^BACKUP_FORMAT_VERSION=[0-9]+' "$REPO_ROOT/deploy/backup-restore.sh" | cut -d= -f2)" == "$(grep -oE '^BACKUP_FORMAT_VERSION=[0-9]+' "$INSTALLER" | cut -d= -f2)" ]] && echo ok || echo fail)"

echo
printf '%d passed, %d failed\n' "$passed" "$failed"
exit $((failed > 0 ? 1 : 0))
