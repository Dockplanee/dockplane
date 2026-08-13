# Dockplane Documentation

This directory is the documentation. The website renders and links these pages;
nothing here is maintained a second time somewhere else.

## Getting started

| | |
| --- | --- |
| [Overview](getting-started/overview.md) | what Dockplane is, and what it is not |
| [Installation](getting-started/installation.md) | put the control plane on a machine |
| [Add a Host](getting-started/add-host.md) | connect a Docker host with one command |

## Operations

| | |
| --- | --- |
| [Upgrading](operations/upgrade.md) | move to a newer release, and the safety backup |
| [Backup and Restore](operations/backup-restore.md) | what a backup holds, and coming back from one |
| [The Agent](operations/agent.md) | the host side, and what the control plane does with it |
| [Container Operations](operations/container-lifecycle.md) | start, stop, restart |
| [Container Logs](operations/container-logs.md) | historical output and live streams |
| [Troubleshooting](operations/troubleshooting.md) | what to check when something is wrong |
| [Building a Release](operations/releases.md) | for maintainers |

## Security

| | |
| --- | --- |
| [Security Model](security/security-model.md) | trust boundaries, and control without a shell |
| [Agent Security](security/agent-security.md) | enrollment, identity, revocation |
| [Authentication](security/authentication.md) | sessions, MFA, permissions, audit |
| [Vulnerability Assessment](security/vulnerabilities.md) | what the scans find, and what is being done about it |

## Reference

| | |
| --- | --- |
| [Architecture](reference/architecture.md) | how the pieces fit together |
| [Supported Platforms](reference/supported-platforms.md) | what is supported, and what is not |
| [Known Limitations](reference/known-limitations.md) | what this release does not do |
| [Compose Support](reference/compose-support.md) | which Compose features Dockplane reads, and which it refuses |
| [Agent Protocol](reference/agent-protocol.md) | the wire protocol |
| [Agent Gateway](reference/agent-gateway.md) | the mutual-TLS endpoint |
| [Agent Identity](reference/agent-identity.md) | certificates and the authority |
| [Interface Versions](reference/interface-versions.md) | what has to match between components |
| [Docker Integration](integrations/docker.md) | how the agent talks to the Engine |

## Product

| | |
| --- | --- |
| [Product Scope](product/PRODUCT_SCOPE.md) | what belongs in Dockplane |
| [Release notes](releases/) | per release |
| [Design](design/) | brand, website and application specifications |

## Development

| | |
| --- | --- |
| [Running locally](development/running-locally.md) | the control server from source |
| [Contributing](../CONTRIBUTING.md) | how to work on this |
