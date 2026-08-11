# Security Policy

## Security Model

Dockplane controls Docker infrastructure and therefore crosses privileged trust boundaries.

A compromised control server or agent can have significant operational impact. Security decisions favor explicit trust, least privilege, constrained capabilities and auditability.

## Vulnerability Reporting

Report vulnerabilities privately through GitHub's private vulnerability reporting:

```text
https://github.com/Dockplanee/dockplane/security/advisories/new
```

Do not open a public issue for an exploitable problem, and do not publish it before the maintainers have investigated and prepared a fix.

A report should include:
- affected version
- component
- reproduction
- impact
- sanitized logs
- mitigation if known

## Agent Identity

Each agent has an individual identity.

Requirements:
- short-lived enrollment secret
- unique device credential
- encrypted transport
- authenticated control server
- independent revocation
- strict capability validation
- request expiry for sensitive operations
- action timeouts

A revoked agent must no longer be trusted even if network connectivity remains.

## No Arbitrary Remote Shell

Dockplane does not use a generic remote command channel as its management model.

Remote requests must map to explicit capabilities with validated payloads.

## Docker Daemon

Docker daemon access is highly privileged and can be root-equivalent depending on configuration.

Installation documentation must state this clearly.

Do not expose an unauthenticated Docker TCP endpoint to make agent deployment easier.

The central control server must not mount Docker sockets from remote hosts.

## Authentication

Use modern password hashing such as Argon2id.

Support:
- MFA/TOTP
- recovery codes
- session visibility/revocation
- expiring reset tokens
- login throttling

Never log passwords, MFA seeds or reset tokens.

## Browser Sessions

Production should use:
- HTTPS
- HttpOnly cookies
- Secure cookies
- suitable SameSite policy
- CSRF defense where applicable
- restrictive CORS
- security headers
- session invalidation/revocation

## Authorization

Every sensitive backend endpoint and dispatched agent action requires authorization.

Frontend visibility is never considered access control.

## Secrets

Do not log:
- passwords
- private keys
- full API tokens
- session cookies
- enrollment secrets
- MFA seeds
- unrestricted environment data

Stored secrets must be encrypted at rest using application-managed encryption material.

## Audit

Audit:
- authentication changes
- role/permission changes
- enrollment/revocation
- container lifecycle mutations
- Compose operations
- configuration changes
- security-sensitive operations

Do not include secrets in audit entries.

## Replay Resistance

Sensitive agent requests should include:
- unique request ID
- issued timestamp
- expiry timestamp
- authenticated transport
- additional replay protection where needed

Expired requests are rejected.

## Dependency Security

CI should include:
- dependency scanning
- secret scanning
- static analysis
- Go vulnerability checks
- container image scanning where practical

Findings should not be suppressed without a documented reason.

## Secure Defaults

Production must reject clearly unsafe critical configuration.

Development-only behavior must be explicit and must not silently activate in production.

## Public Website

The public website should have minimal attack surface:
- static/prerendered pages where possible
- no public administration panel
- no unnecessary cookies
- no mandatory third-party analytics
- no secrets in frontend bundles
- strict CSP-compatible design
