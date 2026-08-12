/*
 * Generated from docs/ by scripts/generate-docs-index.mjs. Do not edit.
 *
 * The documentation lives in docs/ and is written once. This file is an index
 * of it, rebuilt before every build.
 */

export interface DocPage {
  readonly title: string;
  readonly summary: string;
  readonly url: string;
}

export interface DocSection {
  readonly title: string;
  readonly summary: string;
  readonly pages: readonly DocPage[];
}

export const DOCS_REPOSITORY = 'https://github.com/Dockplanee/dockplane/tree/main/docs';

export const DOC_SECTIONS: readonly DocSection[] = [
  {
    "title": "Getting started",
    "summary": "What Dockplane is, how to install it, and how to connect a Docker host.",
    "pages": [
      {
        "title": "Overview",
        "summary": "Dockplane is a self-hosted control plane for managing Docker across multiple hosts.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/getting-started/overview.md"
      },
      {
        "title": "Installation",
        "summary": "Dockplane is two things to install: a control plane, and an agent on each Docker host you want to manage.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/getting-started/installation.md"
      },
      {
        "title": "Add a Host",
        "summary": "A Docker host joins Dockplane by enrolling an agent. One command does all of it: it works out what the machine is, downloads the agent package matching this control plane, checks it against the checksums published with that release, installs it, enrolls the host and starts the service.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/getting-started/add-host.md"
      }
    ]
  },
  {
    "title": "Operations",
    "summary": "Running it: upgrades, backups, the agent, and what to check when something is wrong.",
    "pages": [
      {
        "title": "Upgrading",
        "summary": "The installer is the upgrade. Download the release, check it, unpack it, run it. There is one supported path and this is it.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/operations/upgrade.md"
      },
      {
        "title": "Backup and Recovery",
        "summary": "A Dockplane control plane is three things, and a backup that has fewer than all three is not a backup:",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/operations/backup-restore.md"
      },
      {
        "title": "The Agent",
        "summary": "The agent runs on each managed Docker host, natively under systemd. It is deliberately not a container: it manages the Docker daemon it runs beside.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/operations/agent.md"
      },
      {
        "title": "Container Operations",
        "summary": "Dockplane can start, stop and restart a container it has discovered. These are the only operations that change a managed host.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/operations/container-lifecycle.md"
      },
      {
        "title": "Container Logs",
        "summary": "Dockplane can read what a container has printed, and follow it as it prints more. That is the whole of it: there is no console, no shell and no way to send anything to a container.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/operations/container-logs.md"
      },
      {
        "title": "Troubleshooting",
        "summary": "The agent logs structured JSON to standard error, so journalctl -u dockplane-agent is the first place to look. Every line carries an event field; the ones named below are what to search for.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/operations/troubleshooting.md"
      },
      {
        "title": "Recovery",
        "summary": "Three things must survive a control-server loss, and they are deliberately kept apart. A backup of only one of them is not a backup.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/operations/recovery.md"
      },
      {
        "title": "Building a Release",
        "summary": "A Dockplane release has two halves, built by one command each: the control plane images, and the agent packages.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/operations/releases.md"
      }
    ]
  },
  {
    "title": "Security",
    "summary": "Trust boundaries, how a host proves who it is, and how operators sign in.",
    "pages": [
      {
        "title": "Security Model",
        "summary": "Dockplane crosses:",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/security/security-model.md"
      },
      {
        "title": "Agent Enrollment",
        "summary": "Enrollment is how a Docker host obtains its own identity. An administrator issues a short-lived token, the host exchanges it once for a client certificate, and the token is spent in the process.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/security/agent-security.md"
      },
      {
        "title": "Authentication",
        "summary": "Dockplane authenticates operators against local accounts and keeps session state on the server.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/security/authentication.md"
      },
      {
        "title": "Vulnerability Assessment",
        "summary": "Every release is scanned, both images on both architectures, and the report for each is published as a release asset. This page is the assessment behind those numbers: what is in them, what was fixed, and why what remains is still there.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/security/vulnerabilities.md"
      }
    ]
  },
  {
    "title": "Reference",
    "summary": "Architecture, supported platforms, limitations, and the agent interfaces.",
    "pages": [
      {
        "title": "Architecture",
        "summary": "What a running Dockplane looks like. Every arrow is a connection something opens; nothing reaches into a managed host.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/reference/architecture.md"
      },
      {
        "title": "Supported Platforms",
        "summary": "Supported means the installer accepts it and this project tests on it. Nothing below is listed because it is likely to work.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/reference/supported-platforms.md"
      },
      {
        "title": "Known Limitations",
        "summary": "What this release does not do. Some of these are decisions and will not change; the rest are simply not built yet. No dates are promised for either.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/reference/known-limitations.md"
      },
      {
        "title": "Agent Protocol",
        "summary": "The protocol between the control server and an agent. It is not a remote shell protocol and has no message that carries a command.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/reference/agent-protocol.md"
      },
      {
        "title": "Agent Gateway",
        "summary": "The agent gateway is a separate TLS listener from the browser API. Agents connect to it and are required to present a client certificate; browsers connect to the API and are not.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/reference/agent-gateway.md"
      },
      {
        "title": "Agent Identity",
        "summary": "Every Dockplane agent has its own cryptographic identity. There is no shared secret, no global agent key and no credential that can be copied between hosts without being detectable and revocable on its own.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/reference/agent-identity.md"
      },
      {
        "title": "Interface Versions",
        "summary": "Three numbers decide whether two pieces of Dockplane can work together. They are frozen for the 0.1 series: a change to any of them is a deliberate act with a migration story, not something that happens because a struct was edited.",
        "url": "https://github.com/Dockplanee/dockplane/blob/main/docs/reference/interface-versions.md"
      }
    ]
  }
] as const;
