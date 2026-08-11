# Dockplane Application

The authenticated control-plane interface. It is a separate Angular application
from `website/` and is deployed with the Dockplane control server rather than
alongside the public site.

## Development

```bash
npm install
npm start
```

The application runs at `http://localhost:4200`.

## Checks

```bash
npm run build
npm run lint
npm run typecheck
npm test
npm run format:check
```

## Data

Every view reads the control server. There is no fixture in the application and
no build in which one could be rendered; the test double lives under
`src/testing/` and is reachable only from a spec.

```text
src/app/data/dockplane-api.ts       the contract every view depends on
src/app/data/real-dockplane-api.ts  the HTTP implementation
src/app/data/api-contract.ts        the response shapes the server returns
```

Views only ever inject `DockplaneApi`.

A view that changes something — the container lifecycle actions — confirms
first, disables its controls while the request is in flight, and then re-reads
rather than assuming what the operation did. Nothing on screen is set
optimistically.

The fixture is deliberately honest about what does not exist: requesting an
agent revocation returns `CONTROL_SERVER_REQUIRED` rather than reporting a
credential as revoked.

## Structure

```text
src/app/core/         theme, permissions, page context, sorting, formatting
src/app/domain/       inventory and operations types, status vocabulary
src/app/data/         API contract and development fixture
src/app/ui/           shared components: table, badge, dialog, menu, icons
src/app/layout/       sidebar, topbar, search palette
src/app/features/     one folder per area, plus features/shared for the tables
                      that several areas render
```

## Permissions

`src/app/core/permissions.ts` holds the permission set granted to the signed-in
operator. It decides what the interface *offers*: which navigation entries
appear and which actions are enabled.

It is not access control. The control server authorizes every request
independently, so a hidden or disabled control is never a security boundary.
Narrow `DEVELOPMENT_GRANTS` to see how the interface behaves for a lesser role.

## Design

The visual target is `design-reference/app-ui/`. Colour, typography and status
language come from `docs/design/BRAND_SPEC.md`; the layering and density rules
are in `docs/design/APP_UI_SPEC.md`.

Tokens live in `src/styles/tokens.css` and are covered by a contrast test that
checks every foreground against every surface in both themes.
