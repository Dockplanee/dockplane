/**
 * The script a new host runs.
 *
 * It is rendered once, for one machine, in the response to a spent bootstrap
 * ticket, and it is never written to disk on either side. It carries the
 * enrollment token, which is why it is served with `no-store`, is not logged,
 * and is piped straight into a shell rather than downloaded.
 *
 * Everything the script substitutes is either a fixed value from configuration
 * or a token this server generated. Nothing a caller supplied reaches it: the
 * ticket is compared against a digest and then discarded, and the display name
 * an operator typed is not part of the script at all.
 */

export interface InstallScriptOptions {
  /** Where the agent packages come from, without a trailing slash. */
  readonly releaseBaseUrl: string;
  /** The exact agent version this control plane pairs with. Never "latest". */
  readonly agentVersion: string;
  /** Where the agent enrolls. The browser address, not the gateway. */
  readonly controlPlaneUrl: string;
  /** One-time, short-lived, exchanged for a certificate and then dead. */
  readonly enrollmentToken: string;
}

/**
 * The Debian Version field, which is not a file name.
 *
 * A tilde is what dpkg reads as "earlier than", so 0.1.0~rc.3 correctly
 * precedes 0.1.0. It belongs in the package's control data and nowhere else:
 * GitHub rewrites a tilde in a release asset name to a full stop, so a package
 * published under one name would be fetched under another.
 */
export function debianVersion(version: string): string {
  return version.replace(/-/g, '~');
}

/** What the package is called where it is published. Mirrors deploy/release-assets.sh. */
export function agentPackageName(version: string, architecture: string): string {
  return `dockplane-agent_${version}_${architecture}.deb`;
}

/** A released version, as opposed to whatever a working copy calls itself. */
const RELEASE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$/;

/**
 * The agent version a new host will be given.
 *
 * A development build has no published release, so it cannot name one. Saying
 * so here means a misconfigured deployment is refused before anybody's ticket
 * is spent, rather than producing a script that fails halfway through an
 * installation on somebody else's machine.
 */
export function resolveAgentVersion(configured: string, buildVersion: string): string {
  const version = configured || buildVersion;

  if (!RELEASE_VERSION.test(version)) {
    throw new UnreleasedAgentVersionError(version);
  }

  return version;
}

export class UnreleasedAgentVersionError extends Error {
  constructor(readonly version: string) {
    super(`there is no published agent release for version ${version}`);
    this.name = 'UnreleasedAgentVersionError';
  }
}

/**
 * Refuses anything that could change the meaning of the script.
 *
 * These values come from configuration and from this server's own generator, so
 * this is a guard against a mistake rather than against an attacker — but a
 * mistake here executes as root on somebody's machine.
 */
function assertSubstitutable(name: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value)) {
    throw new Error(`${name} is not usable in an installation script`);
  }

  return value;
}

export function renderInstallScript(options: InstallScriptOptions): string {
  const releaseBaseUrl = assertSubstitutable(
    'AGENT_RELEASE_BASE_URL',
    options.releaseBaseUrl.replace(/\/+$/, ''),
    /^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/,
  );
  const agentVersion = assertSubstitutable(
    'agent version',
    options.agentVersion,
    /^[0-9]+\.[0-9]+\.[0-9]+([.~+-][0-9A-Za-z.~+]+)?$/,
  );
  const controlPlaneUrl = assertSubstitutable(
    'PUBLIC_APP_URL',
    options.controlPlaneUrl.replace(/\/+$/, ''),
    /^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/,
  );
  const enrollmentToken = assertSubstitutable(
    'enrollment token',
    options.enrollmentToken,
    /^[A-Za-z0-9_-]+$/,
  );


  return `#!/usr/bin/env bash
#
# Adds this machine to Dockplane.
#
# Downloads the agent package that matches the control plane, checks it against
# the checksums published with that release, installs it, enrolls this host and
# starts the service. It installs nothing else and changes nothing else.

set -euo pipefail

RELEASE_BASE_URL='${releaseBaseUrl}'
AGENT_VERSION='${agentVersion}'
CONTROL_PLANE_URL='${controlPlaneUrl}'
STATE_DIR='/var/lib/dockplane-agent'

fail() {
	echo "dockplane: $*" >&2
	exit 1
}

note() {
	echo "dockplane: $*"
}

[[ "$(id -u)" -eq 0 ]] || fail "this must run as root; pipe the command into 'sudo bash'"

for tool in curl dpkg sha256sum systemctl uname; do
	command -v "$tool" > /dev/null || fail "missing required command: $tool"
done

# --- what this machine is ---------------------------------------------------

case "$(uname -s)" in
	Linux) ;;
	*) fail "this installer supports Linux only" ;;
esac

case "$(uname -m)" in
	x86_64) ARCH=amd64 ;;
	aarch64 | arm64) ARCH=arm64 ;;
	*) fail "unsupported architecture: $(uname -m). Dockplane publishes amd64 and arm64." ;;
esac

if [[ "$ARCH" == arm64 ]]; then
	note "arm64 is experimental: the package is built and inspected for it, but no"
	note "arm64 machine has been through this in testing. Use amd64 in production."
fi

[[ -r /etc/os-release ]] || fail "cannot identify this distribution: /etc/os-release is missing"
# shellcheck disable=SC1091
. /etc/os-release

supported=no
case "\${ID:-}:\${VERSION_ID:-}" in
	ubuntu:24.04 | ubuntu:22.04 | debian:12) supported=yes ;;
esac

if [[ "$supported" != yes ]]; then
	fail "unsupported distribution: \${PRETTY_NAME:-unknown}. The agent package supports Ubuntu 24.04, Ubuntu 22.04 and Debian 12. Install the agent by hand elsewhere: $CONTROL_PLANE_URL"
fi

# --- what has to be here already --------------------------------------------

command -v docker > /dev/null ||
	fail "Docker Engine is not installed. Dockplane manages Docker and does not install it."

docker info > /dev/null 2>&1 ||
	fail "Docker Engine is installed but not reachable. Start it and run this again."

# An identity is not something to replace behind somebody's back. Re-running the
# command on a host that is already enrolled stops here rather than creating a
# second agent for one machine.
if [[ -s "$STATE_DIR/agent.crt" ]]; then
	fail "this host is already enrolled with Dockplane. Remove it there first, then purge the agent with 'apt purge dockplane-agent'."
fi

# --- the package ------------------------------------------------------------

work="$(mktemp -d)"
cleanup() {
	rm -rf "$work"
}
trap cleanup EXIT

package="dockplane-agent_\${AGENT_VERSION}_\${ARCH}.deb"
release="\${RELEASE_BASE_URL}/v\${AGENT_VERSION}"

note "downloading dockplane-agent $AGENT_VERSION for $ARCH"

curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 --max-time 300 \\
	-o "$work/$package" "\${release}/\${package}" ||
	fail "could not download \${release}/\${package}"

curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 --max-time 60 \\
	-o "$work/SHA256SUMS" "\${release}/SHA256SUMS" ||
	fail "could not download the checksums for this release"

# Checked before anything is installed, and the whole thing stops if it does not
# match. A package that is not what the release says it is does not get run.
expected="$(awk -v name="$package" '$2 == name || $2 == "./" name { print $1 }' "$work/SHA256SUMS" | head -1)"
[[ -n "$expected" ]] || fail "the release checksums do not mention $package"

actual="$(sha256sum "$work/$package" | cut -d' ' -f1)"

if [[ "$actual" != "$expected" ]]; then
	fail "checksum mismatch for $package. The download was not what the release published; nothing has been installed."
fi

note "checksum verified"

# --- install, enroll, start -------------------------------------------------

note "installing the agent"
dpkg -i "$work/$package" > /dev/null || fail "installing $package failed"
rm -f "$work/$package"

note "enrolling this host"

# The token reaches the agent on standard input and appears in no argument list,
# no environment and no shell history. It is written by a shell builtin, so it
# never becomes a separate process either.
install -d -m 0700 -o dockplane-agent -g dockplane-agent "$STATE_DIR"

if ! printf '%s' '${enrollmentToken}' |
	runuser -u dockplane-agent -- env DOCKPLANE_AGENT_STATE_DIR="$STATE_DIR" \\
		dockplane-agent enroll --server "$CONTROL_PLANE_URL" --token-stdin; then
	fail "enrollment failed. Nothing was enrolled; create a new command in Dockplane and try again."
fi

note "starting the service"
systemctl enable --now dockplane-agent || fail "the agent was installed and enrolled, but the service did not start. Check 'systemctl status dockplane-agent'."

note "done. This host will appear in Dockplane within a few seconds."
`;
}
