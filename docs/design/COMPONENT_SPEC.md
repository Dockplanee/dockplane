# Dockplane Component Specification

## Buttons

### Primary
Use Dockplane Mint for the main non-destructive action.

### Secondary
Neutral surface with border.

### Ghost
Low-emphasis action.

### Danger
Reserved for destructive actions.

Do not use the mint primary style for destructive confirmations.

## Status Badge

Contains:
- text label
- semantic color
- optional small icon

Examples:

```text
● Healthy
▲ Degraded
● Offline
? Unknown
```

Do not communicate status by color alone.

## Cards

Use:
- 1px border
- medium radius
- restrained surface difference
- no oversized shadow

Cards should group meaningful information, not serve as decoration.

## Tables

Tables are central to Dockplane.

Requirements:
- sticky header where useful
- sorting where useful
- clear row focus/hover
- keyboard-accessible actions
- responsive overflow strategy
- monospace for technical identifiers where helpful

## Metric Tile

Use for:
- CPU
- memory
- disk
- container counts

A tile should show:
- label
- value
- optional trend/context
- stale indicator when data is old

## Log Viewer

Use:
- JetBrains Mono
- dark log surface in both themes where appropriate
- timestamp column
- horizontal scroll or wrap toggle
- search
- pause/resume
- reconnect state

## Dialogs

Dialogs:
- have a real title
- describe consequence
- use explicit actions
- support keyboard
- return focus correctly

Dangerous actions should not be the default focused button.

## Drawers

Use for contextual inspection where keeping the list visible helps.

Do not put complex destructive flows into narrow drawers.

## Forms

Requirements:
- visible labels
- inline validation
- server-side validation remains authoritative
- help text where security implications exist
- secret fields remain masked
- clear save state

## Toasts

Use for short outcomes:
- success
- warning
- error

Do not use toast-only delivery for critical information that must remain visible.

## Empty State

Include:
- what is empty
- why it matters
- next action when available

## Skeletons

Use skeletons only for expected loading.

For agent-offline/stale state, show the real offline/stale state instead of an indefinite skeleton.

## Icons

Use one consistent icon set.

Icon-only controls require accessible names/tooltips.

## Focus

Use a visible focus ring that works on dark and light surfaces.

Suggested focus color:
- Dockplane Mint or Information Blue depending on contrast/context

## Code / Commands

Render commands separately from normal body copy.

Use copy action where helpful.

Do not render secrets in examples.
