// Generated from CHANGELOG.md by scripts/generate-changelog.mjs. Do not edit.
import { ChangelogRelease } from './changelog-entries';

export const CHANGELOG: readonly ChangelogRelease[] = [
  {
    version: 'Unreleased',
    changes: [
      {
        type: 'Added',
        items: [
          'Dockplane Agent for Linux Docker hosts: explicit enrollment, an outbound mutual-TLS connection, certificate renewal and a fixed capability catalog with no command execution.',
          'Read-only discovery of host inventory and metrics, containers and Compose projects, with snapshot reconciliation so an incomplete pass never removes records that still exist.',
          'Read-only APIs for hosts, containers and Compose projects, protected by backend-enforced permissions, with pagination, filters and explicit stale and observed-at state.',
          'Operational events for agent connectivity, inventory changes and discovery failures, recorded on change and kept separate from the audit trail.',
          'Agent enrollment with single-use, short-lived tokens exchanged for per-agent client certificates issued by an internal certificate authority.',
          'Agent gateway on a dedicated mutual-TLS listener, where an agent\'s identity is derived from its client certificate rather than from anything it sends.',
          'Agent registry with certificate renewal over the authenticated connection, and revocation that closes a live connection and prevents reconnection.',
          'Control server with local authentication, server-side sessions, TOTP multi-factor authentication with single-use recovery codes, backend-enforced roles and permissions, an audit trail and health endpoints.',
          'Container start, stop and restart, each behind its own permission, confirmed before it runs, serialised per container, recorded as an action and in the audit trail, and answered with the container state observed on the host afterwards.',
          'Action history of every container operation carried out through Dockplane, with its actor, result, duration and error code.',
          'Live container logs: a snapshot of what a container has printed and a stream that follows it, behind a permission of its own, with stdout and stderr kept apart, bounded at every stage and honest about anything that could not be delivered. Log content is never stored, audited or written to a server log.',
          'Control-plane interface covering hosts, containers, Compose projects, health, actions, agents, users, roles and the audit log.',
          'Public website covering the product overview, feature catalogue, security model, documentation entry point and changelog.',
          'Initial product, architecture, security and design baseline.',
        ],
      },
    ],
  },
];
