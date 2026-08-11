# Dockplane Content Style

## Voice

Dockplane copy should be:
- direct
- technical
- calm
- precise
- transparent
- professional

Avoid:
- hype
- vague future claims
- unnecessary jokes in operational flows
- exaggerated security language
- marketing superlatives without evidence

## Product Terminology

Prefer:
- Docker host
- host
- agent
- container
- Compose project
- workload
- service
- action
- event
- health
- audit log

## Security Copy

Good:

```text
Remote control without a remote shell.
```

Good:

```text
Each agent uses an individual identity and can be revoked independently.
```

Avoid:

```text
Unhackable infrastructure.
```

Avoid:

```text
Military-grade security.
```

## Action Labels

Use explicit verbs:

```text
Restart container
Stop container
Revoke agent
Save role
```

Avoid:

```text
Continue
Proceed
Do it
Confirm
```

when the action can be named directly.

## Errors

Good:

```text
The container could not be restarted because the agent is offline.
```

Include a request ID when useful for troubleshooting.

Do not expose raw stack traces.

## Documentation

Documentation describes current behavior.

Do not write:
- internal implementation history
- prompt history
- artificial task numbering
- claims about unfinished functionality

## Public Website

Primary website language is English.

Keep sentences short and concrete.

Use technical terms naturally rather than keyword stuffing.

## Changelog

Write changes from the user/operator perspective.

Good:

```text
Added host-scoped permissions for container restart actions.
```

Avoid process-oriented notes.
