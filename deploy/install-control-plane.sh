#!/usr/bin/env bash
#
# Installs the Dockplane control plane.
#
#   sudo deploy/install-control-plane.sh --domain dockplane.example.com
#
# It prepares one directory, generates the secrets and the certificate
# authority that belong to this deployment, starts the Compose stack that
# milestone 8b established, and waits until the control plane is actually
# serving before it says so.
#
# It is safe to run again. A second run never replaces a secret, a key or a
# database; it reports what is already there and finishes what is not.

set -euo pipefail

# --- What this installs -----------------------------------------------------

DEFAULT_DIR=/opt/dockplane
DEFAULT_VERSION=0.1.0-rc.1

# The account the containers run as, on the host and inside them. Deliberately
# not 1000, which on most distributions is the first human login account.
SERVICE_UID=10001
SERVICE_GID=10001

REQUIRED_PORTS=(80 443 9443)
# Room for the images, the database and a working set. Not a projection of how
# large a deployment becomes.
REQUIRED_DISK_MB=5000

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Output -----------------------------------------------------------------
#
# Nothing here ever prints a secret. The one value a person must see once —
# their own password — is typed by them and never echoed.

if [[ -t 1 ]]; then
	BOLD=$'\033[1m' DIM=$'\033[2m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RESET=$'\033[0m'
else
	BOLD='' DIM='' RED='' GREEN='' YELLOW='' RESET=''
fi

step() { printf '\n%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
info() { printf '    %s\n' "$*"; }
note() { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }
good() { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }

fail() {
	printf '\n%serror:%s %s\n' "$RED" "$RESET" "$1" >&2
	shift || true

	for line in "$@"; do
		printf '       %s\n' "$line" >&2
	done

	exit 1
}

usage() {
	cat >&2 <<-EOF
		Install the Dockplane control plane.

		  sudo $0 --domain dockplane.example.com

		Options:
		  --domain <name>       hostname browsers will use; required
		  --version <version>   Dockplane release to install (default $DEFAULT_VERSION)
		  --dir <path>          install directory (default $DEFAULT_DIR)
		  --admin-email <mail>  create the first administrator with this address
		  --admin-password-file <path>
		                        read that administrator's password from a file,
		                        for an unattended installation; the file is
		                        never copied and never echoed
		  --skip-admin          do not create an administrator now
		  --skip-dns-check      continue even if the domain does not resolve here
		  --yes                 do not ask; every answer must come from a flag
		  --help

		Requires Docker Engine with the Compose plugin, already installed and
		running. This installer does not install Docker.
	EOF
	exit 2
}

# --- Arguments --------------------------------------------------------------

DOMAIN=""
VERSION="$DEFAULT_VERSION"
INSTALL_DIR="$DEFAULT_DIR"
ADMIN_EMAIL=""
ADMIN_PASSWORD_FILE=""
# Set only while a password is being handed to the bootstrap command.
HANDOVER=""
SKIP_ADMIN=0
SKIP_DNS_CHECK=0
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
	case "$1" in
		--domain) DOMAIN="${2:-}" && shift 2 ;;
		--version) VERSION="${2:-}" && shift 2 ;;
		--dir) INSTALL_DIR="${2:-}" && shift 2 ;;
		--admin-email) ADMIN_EMAIL="${2:-}" && shift 2 ;;
		--admin-password-file) ADMIN_PASSWORD_FILE="${2:-}" && shift 2 ;;
		--skip-admin) SKIP_ADMIN=1 && shift ;;
		--skip-dns-check) SKIP_DNS_CHECK=1 && shift ;;
		--yes | -y) ASSUME_YES=1 && shift ;;
		--help | -h) usage ;;
		*) fail "unknown option: $1" "Run $0 --help" ;;
	esac
done

# Validated here rather than after the host checks: a mistyped flag should be
# rejected before anything about the machine is inspected.
if [[ -n "$DOMAIN" ]] && ! [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ && ${#DOMAIN} -le 253 ]]; then
	printf 'error: not a valid hostname: %s\n' "$DOMAIN" >&2
	printf '       A hostname such as dockplane.example.com, not a URL.\n' >&2
	exit 1
fi

SECRETS_DIR="$INSTALL_DIR/secrets"
PKI_DIR="$INSTALL_DIR/pki"
STATE_FILE="$INSTALL_DIR/version"

# --- Preflight --------------------------------------------------------------
#
# Everything that could stop the installation is checked before anything is
# written, so a host that cannot run Dockplane is left exactly as it was.

preflight() {
	step "Checking this host"

	[[ "$(id -u)" -eq 0 ]] || fail "this installer must run as root" \
		"It writes under $INSTALL_DIR and talks to the Docker daemon." \
		"Run it with sudo."

	local os_name os_version
	os_name="$(. /etc/os-release 2> /dev/null && echo "${ID:-unknown}")"
	os_version="$(. /etc/os-release 2> /dev/null && echo "${VERSION_ID:-unknown}")"

	case "$os_name-$os_version" in
		ubuntu-24.04 | ubuntu-22.04 | debian-12)
			good "$os_name $os_version"
			;;
		*)
			fail "unsupported operating system: $os_name $os_version" \
				"Dockplane v0.1 is tested on Ubuntu 24.04 and Debian 12." \
				"The Compose stack may well work elsewhere; this installer does not claim it."
			;;
	esac

	local architecture
	architecture="$(uname -m)"

	case "$architecture" in
		x86_64 | aarch64) good "architecture $architecture" ;;
		*) fail "unsupported architecture: $architecture" "Dockplane images are built for x86_64 and aarch64." ;;
	esac

	local missing=()

	for command in docker openssl awk sed grep; do
		command -v "$command" > /dev/null || missing+=("$command")
	done

	[[ ${#missing[@]} -eq 0 ]] || fail "missing commands: ${missing[*]}" \
		"Install them and run this again."

	docker compose version > /dev/null 2>&1 || fail "the Docker Compose plugin is not available" \
		"Dockplane runs as a Compose project." \
		"Install docker-compose-plugin from Docker's repository, then run this again."
	good "docker $(docker --version | awk '{print $3}' | tr -d ,), compose $(docker compose version --short)"

	docker info > /dev/null 2>&1 || fail "the Docker daemon is not reachable" \
		"Start it with: systemctl start docker"
	good "the Docker daemon is running"

	local free_mb
	free_mb="$(df -Pm "$(dirname "$INSTALL_DIR")" | awk 'NR==2 {print $4}')"

	if [[ "$free_mb" -lt "$REQUIRED_DISK_MB" ]]; then
		fail "not enough free space: ${free_mb} MB available under $(dirname "$INSTALL_DIR")" \
			"About ${REQUIRED_DISK_MB} MB is needed for the images and the database."
	fi

	good "${free_mb} MB free"

	check_ports
}

# A port already in use is reported with whatever is using it, and the
# installer stops. Stopping somebody else's service to make room is not a
# decision an installer gets to make.
check_ports() {
	local occupied=()

	for port in "${REQUIRED_PORTS[@]}"; do
		if port_in_use "$port"; then
			local holder
			holder="$(port_holder "$port")"
			occupied+=("$port ${holder:+($holder)}")
		fi
	done

	if [[ ${#occupied[@]} -gt 0 ]]; then
		# Ports held by an existing Dockplane are not a conflict; they are this
		# deployment, already running.
		if [[ "$(installation_state)" != "absent" ]] && compose_running; then
			note "ports ${REQUIRED_PORTS[*]} are held by the Dockplane stack already running here"
			return
		fi

		fail "these ports are already in use: ${occupied[*]}" \
			"Dockplane needs 80 and 443 for the application and 9443 for the agent gateway." \
			"Stop whatever is using them, or install on a host that has them free." \
			"This installer will not stop another service for you."
	fi

	good "ports ${REQUIRED_PORTS[*]} are free"
}

port_in_use() {
	if command -v ss > /dev/null; then
		ss -tlnH "sport = :$1" 2> /dev/null | grep -q . && return 0
	fi

	return 1
}

port_holder() {
	command -v ss > /dev/null || return 0
	ss -tlnpH "sport = :$1" 2> /dev/null | grep -oE 'users:\(\("[^"]+"' | head -1 | tr -d '"' | sed 's/users:((//'
}

# --- Installation state -----------------------------------------------------
#
# A directory that exists says nothing about whether a deployment works. The
# state is derived from the things that actually have to be present.

installation_state() {
	local has_state=0 has_secrets=0 has_pki=0 has_compose=0

	[[ -f "$STATE_FILE" ]] && has_state=1
	[[ -s "$SECRETS_DIR/postgres-password" && -s "$SECRETS_DIR/application-encryption-key" && -s "$SECRETS_DIR/database-url" ]] && has_secrets=1
	[[ -s "$PKI_DIR/agent-ca.key" && -s "$PKI_DIR/agent-ca.crt" && -s "$PKI_DIR/gateway.crt" && -s "$PKI_DIR/gateway.key" ]] && has_pki=1
	[[ -f "$INSTALL_DIR/compose.yaml" && -f "$INSTALL_DIR/.env" && -f "$INSTALL_DIR/Caddyfile" ]] && has_compose=1

	local total=$((has_state + has_secrets + has_pki + has_compose))

	if [[ $total -eq 0 ]]; then
		echo absent
	elif [[ $total -eq 4 ]]; then
		echo complete
	elif [[ $has_secrets -eq 1 || $has_pki -eq 1 ]]; then
		# Material that must never be regenerated is present but something else
		# is not. Finishing is safe; starting over is not.
		echo partial
	else
		echo damaged
	fi
}

compose_running() {
	[[ -f "$INSTALL_DIR/compose.yaml" ]] || return 1
	[[ -n "$(docker compose --project-directory "$INSTALL_DIR" ps --quiet < /dev/null 2> /dev/null)" ]]
}

# --- Domain -----------------------------------------------------------------

valid_domain() {
	[[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] &&
		[[ ${#1} -le 253 ]]
}

ask_domain() {
	if [[ -n "$DOMAIN" ]]; then
		valid_domain "$DOMAIN" || fail "not a valid hostname: $DOMAIN"
		return
	fi

	[[ "$ASSUME_YES" -eq 0 ]] || fail "--domain is required with --yes"

	step "The address browsers will use"
	note "A hostname, not a URL. Its DNS record must point at this server:"
	note "Caddy asks Let's Encrypt for a certificate for it on first start."

	while true; do
		read -r -p "    Domain: " DOMAIN
		valid_domain "$DOMAIN" && break
		warn "that is not a valid hostname; try again"
	done
}

# DNS is checked because a certificate cannot be issued without it, and being
# told that now is better than watching Caddy retry.
check_dns() {
	[[ "$SKIP_DNS_CHECK" -eq 0 ]] || return 0
	command -v getent > /dev/null || return 0

	local resolved local_addresses
	resolved="$(getent ahosts "$DOMAIN" 2> /dev/null | awk '{print $1}' | sort -u)"

	if [[ -z "$resolved" ]]; then
		dns_problem "$DOMAIN does not resolve"
		return
	fi

	local_addresses="$(ip -o addr show scope global 2> /dev/null | awk '{print $4}' | cut -d/ -f1 | sort -u)"

	while read -r address; do
		[[ -z "$address" ]] && continue

		if grep -qxF "$address" <<< "$local_addresses"; then
			good "$DOMAIN resolves to this server ($address)"
			return
		fi
	done <<< "$resolved"

	dns_problem "$DOMAIN resolves to $(tr '\n' ' ' <<< "$resolved"), which is not an address of this server"
}

dns_problem() {
	warn "$1"
	note "Let's Encrypt will not issue a certificate until the DNS record points here."
	note "Nothing else is affected: the stack starts, and Caddy keeps trying."

	if [[ "$ASSUME_YES" -eq 1 ]]; then
		note "continuing, because --yes was given"
		return
	fi

	local answer
	read -r -p "    Continue anyway? [y/N] " answer
	[[ "$answer" =~ ^[Yy] ]] || fail "stopped, so the DNS record can be corrected first" \
		"Nothing has been written."
}

# --- Layout -----------------------------------------------------------------

create_layout() {
	step "Preparing $INSTALL_DIR"

	install -d -m 0755 -o root -g root "$INSTALL_DIR"
	# Owned by the account the containers run as, and by nobody else: these two
	# directories hold every secret this deployment has.
	install -d -m 0700 -o "$SERVICE_UID" -g "$SERVICE_GID" "$SECRETS_DIR"
	install -d -m 0700 -o "$SERVICE_UID" -g "$SERVICE_GID" "$PKI_DIR"

	good "directories created"
}

# --- Secrets ----------------------------------------------------------------
#
# Generated once, from the operating system's random source, and never
# regenerated: replacing the encryption key would orphan every enrolled second
# factor, and replacing the database password would lock the server out of its
# own data.

generate_secret_file() {
	local path="$1" generator="$2" description="$3"

	if [[ -s "$path" ]]; then
		note "$description already exists, keeping it"
		return
	fi

	local value
	value="$($generator)"

	# Written through umask rather than chmod, so it is never briefly readable.
	(
		umask 077
		printf '%s' "$value" > "$path"
	)

	chown "$SERVICE_UID:$SERVICE_GID" "$path"
	chmod 0400 "$path"
	good "$description generated"
}

random_password() {
	# 32 characters from a 62-character alphabet: about 190 bits, from the
	# kernel's random source rather than from a timestamp or a process id.
	openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32
}

random_key() {
	# Exactly 32 bytes, base64 encoded, which is what the server validates.
	openssl rand -base64 32
}

create_secrets() {
	step "Secrets"

	generate_secret_file "$SECRETS_DIR/postgres-password" random_password "database password"
	generate_secret_file "$SECRETS_DIR/application-encryption-key" random_key "application encryption key"

	if [[ ! -s "$SECRETS_DIR/database-url" ]]; then
		local password
		password="$(cat "$SECRETS_DIR/postgres-password")"

		(
			umask 077
			printf 'postgres://dockplane:%s@postgres:5432/dockplane' "$password" > "$SECRETS_DIR/database-url"
		)

		chown "$SERVICE_UID:$SERVICE_GID" "$SECRETS_DIR/database-url"
		chmod 0400 "$SECRETS_DIR/database-url"
		good "database connection string written"
	else
		note "database connection string already exists, keeping it"
	fi
}

# --- Certificate authority --------------------------------------------------

create_agent_ca() {
	step "Agent certificate authority"

	if [[ -s "$PKI_DIR/agent-ca.key" ]]; then
		local subject
		subject="$(openssl x509 -in "$PKI_DIR/agent-ca.crt" -noout -enddate 2> /dev/null || echo '')"
		note "an authority already exists here and will not be replaced"
		note "${subject:-agent-ca.crt is present}"
		return
	fi

	# The same command the documentation describes, run inside the image that
	# ships it, as the account that owns the directory. Nothing about the
	# authority is invented here.
	docker run --rm --user "$SERVICE_UID:$SERVICE_GID" \
		-v "$PKI_DIR:/pki" \
		--entrypoint node "$API_IMAGE:$VERSION" \
		dist/cli/setup-agent-ca.js /pki "$DOMAIN" > /dev/null

	good "authority and gateway certificate created for $DOMAIN"
	note "Back up $PKI_DIR. Losing the key means enrolling every host again."
}

# --- Images -----------------------------------------------------------------

resolve_images() {
	API_IMAGE="${DOCKPLANE_API_IMAGE:-ghcr.io/dockplanee/dockplane-control-server}"
	WEB_IMAGE="${DOCKPLANE_WEB_IMAGE:-ghcr.io/dockplanee/dockplane-web}"
}

pull_images() {
	step "Images for $VERSION"

	for image in "$API_IMAGE:$VERSION" "$WEB_IMAGE:$VERSION"; do
		if docker image inspect "$image" > /dev/null 2>&1; then
			note "$image is already present"
			continue
		fi

		# A release bundle carries its own images, so an installation does not
		# depend on a registry being reachable — or on one existing at all.
		if load_bundled_image "$image"; then
			continue
		fi

		info "pulling $image"
		docker pull --quiet "$image" > /dev/null ||
			fail "could not pull $image" \
				"It is not in this bundle and could not be fetched." \
				"Check the version, or set DOCKPLANE_API_IMAGE and DOCKPLANE_WEB_IMAGE" \
				"to images you built yourself with deploy/build-images.sh."
	done

	verify_bundle
}

# The archives sit beside the installer in a release bundle. Loading one is
# preferred over pulling: it is the image this release was tested with, by
# digest, rather than whatever a tag points at today.
load_bundled_image() {
	local image="$1"
	local name="${image##*/}"
	name="${name%%:*}"
	name="${name#dockplane-}"

	local archive="$SOURCE_DIR/images/${name}-$VERSION.oci.tar"
	[[ -f "$archive" ]] || archive="$SOURCE_DIR/images/control-server-$VERSION.oci.tar"
	[[ "$image" == *"-web"* ]] && archive="$SOURCE_DIR/images/web-$VERSION.oci.tar"

	[[ -f "$archive" ]] || return 1

	info "loading $(basename "$archive")"

	# The archive holds every platform the release was built for; only the one
	# this machine runs is loaded.
	docker load --input "$archive" --platform "linux/$(dpkg --print-architecture 2> /dev/null || uname -m)" \
		> /dev/null 2>&1 || docker load --input "$archive" > /dev/null 2>&1 || return 1

	docker image inspect "$image" > /dev/null 2>&1 ||
		docker tag "$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -m1 "${name}.*$VERSION")" "$image" 2> /dev/null

	docker image inspect "$image" > /dev/null 2>&1
}

# Both images belong to one release. A stack assembled from two versions would
# pair a server with an application that expects a different API.
verify_bundle() {
	local api_version web_version

	api_version="$(docker image inspect "$API_IMAGE:$VERSION" \
		-f '{{index .Config.Labels "org.opencontainers.image.version"}}' 2> /dev/null || echo '')"
	web_version="$(docker image inspect "$WEB_IMAGE:$VERSION" \
		-f '{{index .Config.Labels "org.opencontainers.image.version"}}' 2> /dev/null || echo '')"

	if [[ -n "$api_version" && -n "$web_version" && "$api_version" != "$web_version" ]]; then
		fail "these images are from different releases" \
			"control server: $api_version" \
			"web:            $web_version" \
			"Install one release; a mixed pair is not a configuration Dockplane supports."
	fi

	good "control server and web are both ${api_version:-$VERSION}"
}

# --- Configuration ----------------------------------------------------------

write_configuration() {
	step "Configuration"

	install -m 0644 -o root -g root "$SOURCE_DIR/compose/compose.yaml" "$INSTALL_DIR/compose.yaml"
	install -m 0644 -o root -g root "$SOURCE_DIR/compose/Caddyfile" "$INSTALL_DIR/Caddyfile"

	if [[ -f "$INSTALL_DIR/.env" ]]; then
		# An operator may have tuned this. The version is the one thing the
		# installer owns, and even that only moves forward deliberately.
		note ".env already exists, keeping the operator's settings"
	else
		umask 077
		cat > "$INSTALL_DIR/.env" <<-EOF
			# Written by install-control-plane.sh. Values here are settings, not
			# secrets: passwords and keys live as files under secrets/.
			DOCKPLANE_DOMAIN=$DOMAIN
			DOCKPLANE_VERSION=$VERSION
			DOCKPLANE_API_IMAGE=$API_IMAGE
			DOCKPLANE_WEB_IMAGE=$WEB_IMAGE
			POSTGRES_DB=dockplane
			POSTGRES_USER=dockplane
			DOCKPLANE_PKI_DIR=./pki
			DOCKPLANE_SECRETS_DIR=./secrets
			DOCKPLANE_UID=$SERVICE_UID
			DOCKPLANE_GID=$SERVICE_GID
			AGENT_GATEWAY_PORT=9443
			TRUSTED_PROXY_HOPS=1
			LOG_LEVEL=info
		EOF

		chown root:root "$INSTALL_DIR/.env"
		chmod 0600 "$INSTALL_DIR/.env"
		good ".env written"
	fi

	quiet_compose config --quiet ||
		fail "the Compose configuration is not valid" \
			"This is a bug in the installer rather than something you did." \
			"Run: docker compose --project-directory $INSTALL_DIR config"

	good "Compose configuration is valid"
}

# --- Start ------------------------------------------------------------------

start_stack() {
	step "Starting"

	# The order milestone 8b established: the database, then the schema, then
	# the server. A migration that fails stops the installation here, with the
	# previous state untouched.
	info "database"
	quiet_compose up -d postgres
	wait_for "the database" 120 postgres_healthy

	info "schema"

	if ! quiet_compose run --rm migrate; then
		fail "the schema migration failed" \
			"Nothing has been started against a schema it does not understand." \
			"The database is untouched. See: docker compose --project-directory $INSTALL_DIR logs migrate"
	fi

	good "schema applied"

	info "control server and proxy"
	quiet_compose up -d

	wait_for "the control server" 180 api_ready
	good "the control server is ready"

	wait_for_https
}

compose() {
	docker compose --project-directory "$INSTALL_DIR" "$@"
}

# Compose reads standard input, and an installer started from a pipe or a
# heredoc would have its own script consumed out from under it. Everything
# that does not need to talk to the operator is given nothing to read.
quiet_compose() {
	compose "$@" < /dev/null
}

postgres_healthy() {
	[[ "$(docker inspect -f '{{.State.Health.Status}}' \
		"$(quiet_compose ps -q postgres 2> /dev/null)" 2> /dev/null)" == "healthy" ]]
}

api_ready() {
	compose exec -T api node -e \
		"require('http').get('http://127.0.0.1:3000/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" \
		< /dev/null > /dev/null 2>&1
}

# Polled rather than slept through: a slow machine gets the time it needs and a
# fast one is not made to wait.
wait_for() {
	local description="$1" timeout="$2" probe="$3" waited=0

	while ! "$probe"; do
		sleep 2
		waited=$((waited + 2))

		if [[ $waited -ge $timeout ]]; then
			fail "$description did not become ready within ${timeout}s" \
				"The stack is left running so you can look at it:" \
				"  docker compose --project-directory $INSTALL_DIR ps" \
				"  docker compose --project-directory $INSTALL_DIR logs"
		fi

		if [[ $((waited % 20)) -eq 0 ]]; then
			note "still waiting for $description (${waited}s)"
		fi
	done
}

# HTTPS depends on Let's Encrypt, which depends on DNS the operator may still
# be setting up. Not being able to confirm it is reported, not fatal.
wait_for_https() {
	local waited=0

	while [[ $waited -lt 90 ]]; do
		if curl -fsS --max-time 5 "https://$DOMAIN/health/ready" > /dev/null 2>&1; then
			good "https://$DOMAIN is serving with a valid certificate"
			HTTPS_READY=1
			return
		fi

		sleep 3
		waited=$((waited + 3))
	done

	HTTPS_READY=0
	warn "could not reach https://$DOMAIN yet"
	note "The stack is running. Caddy keeps trying to obtain a certificate;"
	note "this is expected while the DNS record is still propagating."
	note "Watch it with: docker compose --project-directory $INSTALL_DIR logs -f caddy"
}

# --- Administrator ----------------------------------------------------------

bootstrap_admin() {
	[[ "$SKIP_ADMIN" -eq 0 ]] || return 0

	step "The first administrator"

	if administrator_exists; then
		note "an administrator already exists; not creating another"
		return
	fi

	if [[ -z "$ADMIN_EMAIL" ]]; then
		if [[ "$ASSUME_YES" -eq 1 || ! -t 0 ]]; then
			note "no administrator created; use --admin-email, or run:"
			note "  docker compose --project-directory $INSTALL_DIR run --rm --no-deps \\"
			note "    --entrypoint node api dist/cli/bootstrap-admin.js you@example.com \"Your Name\""
			return
		fi

		read -r -p "    Administrator email: " ADMIN_EMAIL
	fi

	DISPLAY_NAME=""

	if [[ -t 0 && -z "$ADMIN_PASSWORD_FILE" ]]; then
		read -r -p "    Display name: " DISPLAY_NAME
	fi

	local -a credential=()

	if [[ -n "$ADMIN_PASSWORD_FILE" ]]; then
		[[ -r "$ADMIN_PASSWORD_FILE" ]] || fail "cannot read $ADMIN_PASSWORD_FILE"

		# Mounted as a file rather than passed through the environment, where
		# `docker inspect` would show it. The operator's own file is left alone;
		# what is mounted is a copy that exists for the length of one command and
		# is readable only by the account the container runs as.
		# Removed explicitly rather than from a RETURN trap: the trap fires
		# after the function's locals are gone, so under `set -u` it fails and
		# takes the exit status of a successful installation with it.
		HANDOVER="$(mktemp)"
		local handover="$HANDOVER"
		(
			umask 077
			cat "$ADMIN_PASSWORD_FILE" > "$handover"
		)
		chown "$SERVICE_UID:$SERVICE_GID" "$handover"
		chmod 0400 "$handover"

		credential=(
			-v "$handover:/run/bootstrap-password:ro"
			-e DOCKPLANE_BOOTSTRAP_PASSWORD_FILE=/run/bootstrap-password
		)
		note "reading the password from $ADMIN_PASSWORD_FILE"
	else
		note "The password is typed into the prompt below and is never echoed,"
		note "logged, or passed as an argument."
	fi

	# With a password file there is nothing to type, so the command is given
	# nothing to read: an installer started from a pipe would otherwise have
	# the rest of its own input consumed here. Without one it keeps the
	# terminal, because that is where the password is typed.
	local -a input=()
	[[ -n "$ADMIN_PASSWORD_FILE" ]] && input=(-T)

	if ! run_bootstrap "${input[@]}" "${credential[@]}"; then
		discard_handover
		warn "the administrator was not created"
		note "The control plane is installed and running. Create one with:"
		note "  docker compose --project-directory $INSTALL_DIR run --rm --no-deps \\"
		note "    --entrypoint node api dist/cli/bootstrap-admin.js you@example.com \"Your Name\""
		return
	fi

	discard_handover
	good "administrator created"
}

# Split out so the password-file path can close standard input while the
# interactive path keeps it.
run_bootstrap() {
	if [[ -n "$ADMIN_PASSWORD_FILE" ]]; then
		compose run --rm --no-deps "$@" --entrypoint node api \
			dist/cli/bootstrap-admin.js "$ADMIN_EMAIL" "${DISPLAY_NAME:-$ADMIN_EMAIL}" < /dev/null
	else
		compose run --rm --no-deps "$@" --entrypoint node api \
			dist/cli/bootstrap-admin.js "$ADMIN_EMAIL" "${DISPLAY_NAME:-$ADMIN_EMAIL}"
	fi
}

# The copy of the password that was mounted for one command.
discard_handover() {
	[[ -n "${HANDOVER:-}" ]] || return 0
	rm -f "$HANDOVER"
	HANDOVER=""
}

# The password is read inside the container from the file it is already
# mounted as, so it never becomes an argument or an environment variable on
# this host.
administrator_exists() {
	local count
	count="$(compose exec -T postgres sh -c \
		'PGPASSWORD=$(cat /run/secrets/postgres-password) psql -U dockplane -d dockplane -tAc "select count(*) from users where deactivated_at is null"' \
		< /dev/null 2> /dev/null | tr -d '[:space:]')"

	[[ -n "$count" && "$count" != "0" ]]
}

# --- Result -----------------------------------------------------------------

record_state() {
	umask 022
	cat > "$STATE_FILE" <<-EOF
		# Written by install-control-plane.sh. Read by the installer to recognise
		# an existing deployment; not configuration.
		version=$VERSION
		domain=$DOMAIN
		installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	EOF
	chmod 0644 "$STATE_FILE"
}

verify_permissions() {
	step "Checking what was written"

	local problems=0

	expect_mode() {
		local path="$1" expected="$2"
		local actual
		actual="$(stat -c '%a' "$path" 2> /dev/null || echo missing)"

		if [[ "$actual" != "$expected" ]]; then
			warn "$path is $actual, expected $expected"
			problems=$((problems + 1))
		fi
	}

	expect_mode "$INSTALL_DIR/.env" 600
	expect_mode "$SECRETS_DIR" 700
	expect_mode "$PKI_DIR" 700

	for secret in "$SECRETS_DIR"/*; do
		if [[ -f "$secret" ]]; then
			expect_mode "$secret" 400
		fi
	done

	if [[ -f "$PKI_DIR/agent-ca.key" ]]; then
		expect_mode "$PKI_DIR/agent-ca.key" 600
	fi

	# World-writable configuration would let any local user change what the
	# control plane runs as.
	for file in "$INSTALL_DIR/compose.yaml" "$INSTALL_DIR/Caddyfile"; do
		if [[ -f "$file" && "$(stat -c '%a' "$file")" =~ [2367]$ ]]; then
			warn "$file is world-writable"
			problems=$((problems + 1))
		fi
	done

	if [[ $problems -eq 0 ]]; then
		good "permissions are as they should be"
	else
		warn "$problems permission problem(s) above; fix them before exposing this deployment"
	fi
}

summary() {
	local gateway="$DOMAIN"

	cat <<-EOF

		${BOLD}Dockplane $VERSION is installed.${RESET}

		  URL              https://$DOMAIN
		  Agent gateway    $gateway:9443
		  Directory        $INSTALL_DIR

		Open the URL and sign in. Then add a Docker host: create an enrollment
		token under Agents, install dockplane-agent on the host, and enroll it.

		  Manage this deployment
		    $INSTALL_DIR/dockplane-control status
		    $INSTALL_DIR/dockplane-control logs
		    $INSTALL_DIR/dockplane-control doctor

		  Back it up, before you need to
		    $INSTALL_DIR/dockplane-control backup /var/backups/dockplane-\$(date -u +%Y%m%dT%H%M%SZ)

		  Open in the firewall, if you have one
		    80/tcp    certificate issuance and the redirect to HTTPS
		    443/tcp   browsers
		    9443/tcp  enrolled agents

		  Back up
		    $SECRETS_DIR   the encryption key, without which enrolled second factors are lost
		    $PKI_DIR       the agent authority, without which every host must be enrolled again

	EOF

	if [[ "${HTTPS_READY:-0}" -eq 0 ]]; then
		printf '  %sHTTPS is not confirmed yet.%s Check DNS for %s, then:\n' "$YELLOW" "$RESET" "$DOMAIN"
		printf '    curl -fsS https://%s/health/ready\n\n' "$DOMAIN"
	fi
}

install_helper() {
	install -m 0755 -o root -g root "$SOURCE_DIR/dockplane-control" "$INSTALL_DIR/dockplane-control"
	install -m 0644 -o root -g root "$SOURCE_DIR/backup-restore.sh" "$INSTALL_DIR/backup-restore.sh"
}

# --- Main -------------------------------------------------------------------

main() {
	resolve_images

	local state
	state="$(installation_state)"

	if [[ "$state" == "complete" ]]; then
		step "Dockplane is already installed in $INSTALL_DIR"
		# Read back rather than asked again: the domain is already decided, and
		# changing it silently would invalidate the gateway certificate.
		DOMAIN="$(awk -F= '/^domain=/{print $2}' "$STATE_FILE" 2> /dev/null || true)"
		[[ -n "$DOMAIN" ]] || DOMAIN="$(awk -F= '/^DOCKPLANE_DOMAIN=/{print $2}' "$INSTALL_DIR/.env")"
		note "domain $DOMAIN"
		note "Nothing will be regenerated. Continuing will start what is not running,"
		note "apply any pending schema change, and check the result."

		if [[ "$ASSUME_YES" -eq 0 && -t 0 ]]; then
			local answer
			read -r -p "    Continue? [Y/n] " answer
			[[ ! "$answer" =~ ^[Nn] ]] || exit 0
		fi
	fi

	preflight

	case "$state" in
		absent)
			ask_domain
			check_dns
			;;
		partial | damaged)
			step "An unfinished installation is already in $INSTALL_DIR"
			note "state: $state"
			note "Secrets and the certificate authority, if present, are kept as they are."

			if [[ -f "$INSTALL_DIR/.env" ]]; then
				DOMAIN="$(awk -F= '/^DOCKPLANE_DOMAIN=/{print $2}' "$INSTALL_DIR/.env")"
				note "domain $DOMAIN, from the existing .env"
			else
				ask_domain
				check_dns
			fi
			;;
	esac

	create_layout
	create_secrets
	pull_images
	create_agent_ca
	write_configuration
	install_helper
	start_stack

	# Written only once the stack is actually serving, so a failed installation
	# never leaves something that claims to be finished.
	record_state
	verify_permissions
	bootstrap_admin
	summary
}

main "$@"
