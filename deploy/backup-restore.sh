#!/usr/bin/env bash
#
# Backup and restore for the Dockplane control plane.
#
# Sourced by dockplane-control; not run directly. Kept in its own file because
# restore is the most destructive thing this project does and deserves to be
# read on its own.
#
# A Dockplane deployment is three things, and a backup is worth nothing unless
# it has all three:
#
#   the database        who exists, what they may do, what happened
#   the encryption key  without it, MFA secrets in that database are unreadable
#   the agent authority without it, every managed host must be enrolled again
#
# Caddy's certificates are included too, as an optional fourth part. They are
# not an identity — Let's Encrypt will issue new ones — but reissuing is rate
# limited, and a rebuild after an incident is exactly when those attempts have
# already been spent. A backup without them still restores.

# The format the manifest declares. A restore refuses anything it does not
# understand rather than guessing at a layout it has never seen.
BACKUP_FORMAT_VERSION=1

# --- Backup -----------------------------------------------------------------

backup_usage() {
	cat >&2 <<-EOF
		Usage: $(basename "$0") backup <directory>

		Writes a complete backup of this control plane: the database, the
		secrets, and the agent certificate authority.

		  $(basename "$0") backup /var/backups/dockplane-\$(date -u +%Y%m%dT%H%M%SZ)

		The result contains this deployment's private keys in the clear. It is
		created readable only by root; keep it somewhere that stays that way.
	EOF
	exit 2
}

do_backup() {
	local target="${1:-}"

	[[ -n "$target" ]] || backup_usage

	[[ "$(id -u)" -eq 0 ]] || {
		echo "backup must run as root: it reads this deployment's private keys" >&2
		exit 1
	}

	[[ ! -e "$target" ]] || {
		echo "refusing to write over $target" >&2
		echo "Choose a name that does not exist; nothing here removes a backup." >&2
		exit 1
	}

	local parent
	parent="$(dirname "$target")"
	[[ -d "$parent" ]] || {
		echo "no such directory: $parent" >&2
		exit 1
	}

	# Everything is assembled under a name that is obviously not a backup, and
	# only becomes one when it is complete. An interrupted run leaves
	# `.partial` behind rather than something that looks usable.
	local staging="${target}.partial"
	rm -rf "$staging"

	local previous_umask
	previous_umask="$(umask)"
	umask 077

	mkdir -p "$staging/secrets" "$staging/pki"

	printf '%sBacking up%s %s\n' "$BOLD" "$RESET" "$INSTALL_DIR"

	if ! backup_database "$staging"; then
		rm -rf "$staging"
		umask "$previous_umask"
		echo "backup failed: the database could not be dumped; nothing was written" >&2
		exit 1
	fi

	if ! backup_files "$staging"; then
		rm -rf "$staging"
		umask "$previous_umask"
		echo "backup failed: a secret or key could not be read; nothing was written" >&2
		exit 1
	fi

	write_manifest "$staging"

	# Verified before the backup is given its real name, so a backup that
	# exists is a backup that has been checked at least once.
	if ! (cd "$staging" && sha256sum -c SHA256SUMS > /dev/null 2>&1); then
		rm -rf "$staging"
		umask "$previous_umask"
		echo "backup failed: the checksums did not verify; nothing was written" >&2
		exit 1
	fi

	chmod 0700 "$staging"
	mv "$staging" "$target"
	umask "$previous_umask"

	ok "database, secrets and certificate authority"
	ok "checksums verified"

	printf '\n  %s%s%s\n' "$BOLD" "$target" "$RESET"
	printf '  %s\n\n' "$(du -sh "$target" | cut -f1)"
	cat <<-EOF
		  This backup contains the agent certificate authority's private key and
		  the application encryption key, both unencrypted. It is mode 0700 and
		  owned by root. Anyone who reads it can impersonate every managed host.
		  Keep it on encrypted storage, and treat a copy of it as a copy of the
		  whole deployment.

	EOF
}

# pg_dump inside the container, in PostgreSQL's own format, with the password
# read from the file it is already mounted as: it never becomes an argument on
# this host, where every other user could read it from the process list.
backup_database() {
	local staging="$1"

	printf '  database\n'

	compose exec -T postgres sh -c \
		'PGPASSWORD=$(cat /run/secrets/postgres-password) pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges' \
		< /dev/null > "$staging/database.dump" 2> /dev/null || return 1

	[[ -s "$staging/database.dump" ]] || return 1
}

backup_files() {
	local staging="$1"

	printf '  secrets and certificate authority\n'

	for secret in postgres-password database-url application-encryption-key; do
		[[ -r "$INSTALL_DIR/secrets/$secret" ]] || return 1
		cp -p "$INSTALL_DIR/secrets/$secret" "$staging/secrets/$secret" || return 1
	done

	for material in agent-ca.crt agent-ca.key gateway.crt gateway.key; do
		[[ -r "$INSTALL_DIR/pki/$material" ]] || return 1
		cp -p "$INSTALL_DIR/pki/$material" "$staging/pki/$material" || return 1
	done

	# Settings rather than secrets, but a restore onto a bare host needs them.
	cp -p "$INSTALL_DIR/.env" "$staging/env" || return 1

	backup_caddy_state "$staging"

	chmod 0600 "$staging"/secrets/* "$staging"/pki/*.key "$staging/env"
	chmod 0644 "$staging"/pki/*.crt
}

# Caddy's issued certificates and its ACME account. Copied out of the volume
# by a container, because the volume belongs to Docker rather than to a path on
# this host. A failure here is not a failed backup: everything that cannot be
# reissued is already in it.
backup_caddy_state() {
	local staging="$1"

	mkdir -p "$staging/caddy"

	if compose run --rm --no-deps --entrypoint sh -T \
		-v "$staging/caddy:/backup" caddy \
		-c 'cd /data && tar cf - . 2> /dev/null | (cd /backup && tar xf -)' \
		< /dev/null > /dev/null 2>&1 && [[ -n "$(ls -A "$staging/caddy" 2> /dev/null)" ]]; then
		CADDY_INCLUDED=true
		printf '  certificates\n'
	else
		rmdir "$staging/caddy" 2> /dev/null
		CADDY_INCLUDED=false
	fi
}

write_manifest() {
	local staging="$1"

	local reported schema_version protocol_version api_version
	reported="$(compose exec -T api node -e \
		"require('http').get('http://127.0.0.1:3000/api/v1/version',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>process.stdout.write(b))})" \
		< /dev/null 2> /dev/null || echo '{}')"

	schema_version="$(json_field "$reported" appliedSchemaVersion)"
	protocol_version="$(json_field "$reported" protocolVersion)"
	api_version="$(json_field "$reported" version)"

	cat > "$staging/manifest.json" <<-JSON
		{
		  "backupFormatVersion": $BACKUP_FORMAT_VERSION,
		  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
		  "dockplaneVersion": "$(setting DOCKPLANE_VERSION)",
		  "apiVersion": "${api_version:-unknown}",
		  "schemaVersion": "${schema_version:-unknown}",
		  "protocolVersion": ${protocol_version:-0},
		  "domain": "$(setting DOCKPLANE_DOMAIN)",
		  "databaseFormat": "postgresql-custom",
		  "components": ["database", "secrets", "pki", "env"$([[ "${CADDY_INCLUDED:-false}" == "true" ]] && printf ', "caddy"')],
		  "excluded": ["live-log-streams", "managed-host-data"]
		}
	JSON

	# Over everything the backup contains, including the manifest itself.
	(cd "$staging" && find . -type f ! -name SHA256SUMS -print0 |
		sort -z | xargs -0 sha256sum > SHA256SUMS)
}

# The version endpoint answers with small, flat JSON; this avoids making jq a
# requirement of an installation that otherwise needs nothing but Docker.
json_field() {
	local document="$1" field="$2"
	sed -n "s/.*\"$field\":[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" <<< "$document" | head -1
}

# --- Restore ----------------------------------------------------------------

restore_usage() {
	cat >&2 <<-EOF
		Usage: $(basename "$0") restore <backup directory> [--yes]

		Replaces this control plane's database, secrets and certificate
		authority with the ones in the backup. Everything currently here is
		saved first, and the restore stops if that fails.

		After a restore:
		  every browser session is signed out
		  unused enrollment tokens are invalidated
		  actions that were still running are marked cancelled and never run
		  enrolled agents reconnect on their own, without enrolling again
	EOF
	exit 2
}

do_restore() {
	local source="${1:-}"
	local confirmed=0

	shift || true

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--yes | -y) confirmed=1 && shift ;;
			*) restore_usage ;;
		esac
	done

	[[ -n "$source" ]] || restore_usage

	[[ "$(id -u)" -eq 0 ]] || {
		echo "restore must run as root" >&2
		exit 1
	}

	# Nothing at all is touched until the backup has been read, checked and
	# understood. A restore that fails validation must leave a working
	# deployment exactly as it was.
	validate_backup "$source"

	printf '\n%sThis replaces the control plane in %s.%s\n' "$BOLD" "$INSTALL_DIR" "$RESET"
	printf '  from       %s\n' "$source"
	printf '  taken      %s\n' "$(json_field "$(cat "$source/manifest.json")" createdAt)"
	printf '  version    %s\n' "$(json_field "$(cat "$source/manifest.json")" dockplaneVersion)"
	printf '  schema     %s\n\n' "$(json_field "$(cat "$source/manifest.json")" schemaVersion)"

	if [[ $confirmed -eq 0 ]]; then
		if [[ ! -t 0 ]]; then
			echo "refusing to restore without a terminal; pass --yes to mean it" >&2
			exit 1
		fi

		local answer
		read -r -p "  Type 'restore' to continue: " answer
		[[ "$answer" == "restore" ]] || {
			echo "  nothing was changed"
			exit 1
		}
	fi

	safety_backup
	apply_restore "$source"
}

validate_backup() {
	local source="$1"

	printf '%sChecking the backup%s\n' "$BOLD" "$RESET"

	[[ -d "$source" ]] || fail_restore "no such backup: $source"
	[[ ! -e "${source}.partial" && "$source" != *.partial ]] ||
		fail_restore "$source is an unfinished backup"

	[[ -f "$source/manifest.json" ]] || fail_restore "the backup has no manifest.json"
	[[ -f "$source/SHA256SUMS" ]] || fail_restore "the backup has no checksums"

	local manifest format
	manifest="$(cat "$source/manifest.json")"
	format="$(json_field "$manifest" backupFormatVersion)"

	[[ "$format" =~ ^[0-9]+$ ]] || fail_restore "the manifest does not declare a format version"
	[[ "$format" -le "$BACKUP_FORMAT_VERSION" ]] ||
		fail_restore "this backup is format $format; this version understands up to $BACKUP_FORMAT_VERSION" \
			"It was written by a newer Dockplane. Restore it with that version."

	ok "format $format"

	# Every component, named rather than assumed: a backup missing its
	# encryption key would restore a database nobody can read the secrets in.
	for required in database.dump secrets/application-encryption-key secrets/postgres-password \
		secrets/database-url pki/agent-ca.crt pki/agent-ca.key pki/gateway.crt pki/gateway.key env; do
		[[ -s "$source/$required" ]] || fail_restore "the backup is missing $required" \
			"A backup without it cannot restore a working deployment."
	done

	ok "database, secrets and certificate authority are present"

	(cd "$source" && sha256sum -c SHA256SUMS > /dev/null 2>&1) ||
		fail_restore "the checksums do not match" \
			"This backup has been changed or is damaged. Nothing was restored."

	ok "checksums match"

	# The database this build can run is the one it has migrations for. A dump
	# from a newer schema would restore tables the running server does not know.
	local backup_schema running_schema
	backup_schema="$(json_field "$manifest" schemaVersion)"
	running_schema="$(json_field "$(compose exec -T api node -e \
		"require('http').get('http://127.0.0.1:3000/api/v1/version',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>process.stdout.write(b))})" \
		< /dev/null 2> /dev/null || echo '{}')" schemaVersion)"

	if [[ -n "$running_schema" && -n "$backup_schema" && "$backup_schema" != "unknown" ]]; then
		if [[ "$backup_schema" > "$running_schema" ]]; then
			fail_restore "the backup's schema is newer than this version understands" \
				"backup:  $backup_schema" \
				"running: $running_schema" \
				"Upgrade Dockplane first, then restore."
		fi

		ok "schema $backup_schema can be read by this version"
	fi
}

fail_restore() {
	printf '\n%serror:%s %s\n' "$RED" "$RESET" "$1" >&2
	shift || true

	for line in "$@"; do
		printf '       %s\n' "$line" >&2
	done

	printf '       Nothing has been changed.\n' >&2
	exit 1
}

# Taken before anything is replaced, and a failure here stops the restore. A
# recovery procedure that destroys the thing it was meant to recover from is
# worse than no recovery procedure.
safety_backup() {
	local stamp
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	SAFETY_PATH="$INSTALL_DIR/pre-restore-$stamp"

	printf '\n%sSaving what is here first%s\n' "$BOLD" "$RESET"

	if ! do_backup "$SAFETY_PATH" > /dev/null 2>&1; then
		fail_restore "could not back up the current deployment" \
			"The restore has stopped rather than replace something it could not save." \
			"Fix the problem, or move the current installation aside deliberately."
	fi

	ok "saved to $SAFETY_PATH"
}

apply_restore() {
	local source="$1"

	printf '\n%sRestoring%s\n' "$BOLD" "$RESET"

	# The server and the proxy stop; the database stays up because it is what
	# receives the dump.
	printf '  stopping the control server\n'
	compose stop api caddy < /dev/null > /dev/null 2>&1

	printf '  secrets and certificate authority\n'

	# The encryption key, and only the encryption key. It is what makes the MFA
	# secrets in the dump readable, so it must be the one the backup was taken
	# with. The database password is deliberately not restored: a dump carries
	# tables, not roles, so the credentials that work are the ones this
	# PostgreSQL was initialised with — on a rebuilt host, the new ones.
	restore_in_place "$source/secrets/application-encryption-key" \
		"$INSTALL_DIR/secrets/application-encryption-key"

	# Exactly the authority from the backup. Generating a new one here would
	# leave every enrolled host holding a certificate from an authority this
	# deployment no longer trusts.
	# The PKI is mounted as a directory rather than as individual files, so
	# replacing what is in it is enough.
	for material in agent-ca.crt gateway.crt; do
		install -m 0644 -o "${DOCKPLANE_UID:-10001}" -g "${DOCKPLANE_GID:-10001}" \
			"$source/pki/$material" "$INSTALL_DIR/pki/$material"
	done

	for material in agent-ca.key gateway.key; do
		install -m 0600 -o "${DOCKPLANE_UID:-10001}" -g "${DOCKPLANE_GID:-10001}" \
			"$source/pki/$material" "$INSTALL_DIR/pki/$material"
	done

	printf '  database\n'

	if ! restore_database "$source"; then
		printf '\n%serror:%s the database could not be restored\n' "$RED" "$RESET" >&2
		printf '       The secrets and the certificate authority from the backup are\n' >&2
		printf '       already in place, so this deployment is now between two states.\n' >&2
		printf '       Restore %s to get back to where you were.\n' "${SAFETY_PATH:-the safety backup}" >&2
		exit 1
	fi

	restore_caddy_state "$source"

	apply_restore_policy

	printf '  starting\n'
	compose up -d < /dev/null > /dev/null 2>&1

	wait_for_ready || fail_restore "the control server did not become ready after the restore" \
		"The deployment before this restore is saved at ${SAFETY_PATH:-the safety backup}."

	ok "the control server is ready"

	printf '\n%sRestored.%s\n\n' "$BOLD" "$RESET"
	cat <<-EOF
		  Everyone has been signed out; sign in again.
		  Unused enrollment tokens from before the backup no longer work.
		  Actions that were still running were cancelled and will not run.
		  Enrolled hosts reconnect on their own within about two minutes.

		  The deployment as it was before this restore: ${SAFETY_PATH:-none}
		  Delete it once you are satisfied; nothing here removes it for you.

	EOF
}

# Written through the existing file rather than over it.
#
# Compose mounts a secret as a bind mount of one file, which pins the inode. A
# replacement file would leave every running container reading the old one, and
# the failure — a server quietly using the wrong encryption key — is the kind
# that is discovered weeks later.
restore_in_place() {
	local from="$1" to="$2"

	if [[ -e "$to" ]]; then
		cat "$from" > "$to"
	else
		install -m 0400 -o "${DOCKPLANE_UID:-10001}" -g "${DOCKPLANE_GID:-10001}" "$from" "$to"
	fi
}

restore_database() {
	local source="$1"

	# Dropped and recreated rather than merged: a restore is the backup's state,
	# not the backup's state layered over whatever was here.
	# In Dockplane's own database, not in the maintenance database: dropping
	# schemas in `postgres` would leave the dump colliding with the tables that
	# are still there.
	compose exec -T postgres sh -c \
		'PGPASSWORD=$(cat /run/secrets/postgres-password) psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "drop schema if exists public cascade; create schema public" -c "drop schema if exists drizzle cascade"' \
		< /dev/null > /dev/null 2>&1 || return 1

	compose exec -T postgres sh -c \
		'PGPASSWORD=$(cat /run/secrets/postgres-password) pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error' \
		< "$source/database.dump" > /dev/null 2>&1 || return 1
}

# Put back only if the backup has them. A deployment whose backup predates this
# simply asks Let's Encrypt for a certificate, as it always did.
restore_caddy_state() {
	local source="$1"

	[[ -d "$source/caddy" && -n "$(ls -A "$source/caddy" 2> /dev/null)" ]] || return 0

	printf '  certificates\n'

	compose run --rm --no-deps --entrypoint sh -T \
		-v "$source/caddy:/backup:ro" caddy \
		-c 'cd /backup && tar cf - . 2> /dev/null | (cd /data && tar xf -)' \
		< /dev/null > /dev/null 2>&1 || true
}

# What a restored database must not be allowed to do.
apply_restore_policy() {
	printf '  signing everyone out, invalidating unused tokens, cancelling stale actions\n'

	compose exec -T postgres sh -c \
		'PGPASSWORD=$(cat /run/secrets/postgres-password) psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q -f -' \
		< /dev/null > /dev/null 2>&1 <<-'SQL' || true
		-- A session cookie from before a disaster is a credential nobody
		-- decided to keep. Whoever holds one signs in again.
		update sessions set revoked_at = now() where revoked_at is null;

		-- A one-time enrollment token that was never used would become usable
		-- again, days or weeks later, in a deployment that has been rebuilt.
		update agent_enrollment_tokens set revoked_at = now()
		where consumed_at is null and revoked_at is null;

		-- An action that was queued or running when the backup was taken has
		-- no dispatch behind it any more. Left as it was, the first agent to
		-- reconnect could be handed a stop request from another week.
		update actions set status = 'cancelled', completed_at = now()
		where status in ('queued', 'running');
	SQL
}

wait_for_ready() {
	local waited=0

	while [[ $waited -lt 180 ]]; do
		if compose exec -T api node -e \
			"require('http').get('http://127.0.0.1:3000/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" \
			< /dev/null > /dev/null 2>&1; then
			return 0
		fi

		sleep 3
		waited=$((waited + 3))
	done

	return 1
}
