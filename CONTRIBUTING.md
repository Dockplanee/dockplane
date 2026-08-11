# Contributing

## Principles

Changes should be focused, testable and maintainable.

Dockplane controls infrastructure, so security-sensitive behavior receives additional scrutiny.

## Branches

Create a dedicated branch for substantial work.

Examples:

```text
feature/public-website
feature/docker-inventory
feature/agent-enrollment
fix/action-timeout
docs/agent-installation
```

## Commits

Use Conventional Commits.

Examples:

```text
feat(api): add host registration
fix(agent): reject expired action requests
test(auth): cover revoked sessions
docs(docker): explain daemon privileges
```

## Pull Requests

Describe:
- what changed
- why
- security implications
- test coverage
- documentation impact

## Quality

Before merging:
- format
- lint
- typecheck
- unit tests
- relevant integration tests
- frontend build
- backend build
- Go tests
- security checks where configured

## Documentation

Keep docs aligned with actual behavior.

Do not advertise or document functionality that does not exist.

## Security

Do not introduce arbitrary remote command execution to simplify an integration.

Prefer typed APIs and narrowly scoped capabilities.
