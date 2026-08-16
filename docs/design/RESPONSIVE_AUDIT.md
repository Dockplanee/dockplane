# Responsive Audit

What the interface does at the widths people use it at, measured against the
published 0.2.0 release, and what the layout has to become.

Nothing here has been changed yet. This is the record the responsive work is
planned from, and the assertions in `app/e2e/responsive-smoke.e2e.mjs` are
written against it.

## Method

Eighty-five measurements: seventeen screens at five viewport widths, taken in a
real browser against a deployed 0.2.0 instance with real data — six host
identities sharing one system hostname, thirty-four containers, six Compose
projects. Boundary widths of 1280 and 1500 were used to find where a behaviour
changes rather than to check it.

Each measurement reads the page rather than a picture of it: the width the
document scrolls to, the width a table wants against the width it is given,
which columns fall outside the window, whether navigation, the primary action
and a row's actions can be reached, and the height of the smallest interactive
control. A screenshot comparison would fail for a font and pass for a row whose
action menu sits four hundred pixels to the right.

Read-only throughout. Nothing was created, changed or deleted.

## Viewports

| Class | Width | Stands for |
| --- | --- | --- |
| mobile | 375 | a phone held upright |
| small tablet | 600 | a small tablet, a split window |
| tablet | 768 | a tablet, a narrow laptop window |
| laptop | 1024 | the width the product was verified at until now |
| desktop | 1440 | a full-screen laptop or a monitor |

## Target strategy

**1440 and above — full table.** Every column the screen defines may be shown.

**900 to 1439 — compact table.** What an operator needs to act has to be in the
window without moving it sideways: the resource, the host identity where it
distinguishes anything, the state, the health or last-known marker, and the
actions. Secondary data may move into a second line, an expander, or the detail
page.

**Below 900 — compact list.** A desktop table is not squeezed into a phone. Each
resource becomes a row that still reads as an operations tool rather than a
marketing card: primary identity, secondary identity, state and health, the one
piece of context that matters on that screen, and an action menu. No operational
information behind a horizontal scroll.

## What already works

The shell adapts. Below 1024 the sidebar becomes a drawer behind an *Open
navigation* control, which measures 34 by 34 and is present on every screen.
Filters and search stack rather than overflow. Host identity survives the
narrowest layout: the given name leads and the system hostname sits under it,
which is what tells six identically-named machines apart. Sixteen of seventeen
screens never scroll the window sideways at any width.

None of this needs redesigning. The work is in the content components.

## Findings

### Severity

**P0** — a primary function cannot be reached or cannot sensibly be used.
**P1** — usable, but important information or actions sit outside the normal
view or are much harder to get to.
**P2** — layout, spacing or readability, without loss of function.
**P3** — cosmetic.

A horizontal scroll is not automatically P0. A table that scrolls but still
shows what a resource is and what state it is in is P1; one that hides the state
and the actions is P0 on the screens where acting is the point.

### Summary

| Severity | Count |
| --- | --- |
| P0 | 2 |
| P1 | 4 |
| P2 | 3 |
| P3 | 1 |

### P0

**Operational columns leave the window on the two widest lists.** On
`/containers` the table wants 1184 pixels and on `/hosts` 1330; below roughly
1500 neither fits, and what falls outside is exactly what an operator came for.
At 375 the containers list shows name, host and part of the image; status,
health, restarts, uptime and the row actions are off-screen. Hosts is worse: it
does not fit even at 1440, where 1330 pixels of table are given 1150. The page
reports no overflow at any width, so nothing about the layout signals that the
rest of the row exists.

**Settings scrolls the window sideways.** The only screen that does: 292 pixels
at 375, 67 at 600, none from 768 up. The sessions table wants 704 pixels in a
341-pixel column and pushes the page rather than scrolling inside its own box,
so the page itself moves under the content.

### P1

**Row actions are unreachable on narrow windows.** On `/containers` and
`/agents` the row action control is outside the window at 375, 600, 768 and
1024, and only comes into view at 1440. Acting on a container from the list is
not possible without scrolling the table sideways first.

**The compact band has no design.** Between 900 and 1439 the tables are the
desktop tables, so the whole band inherits the P0 above rather than having a
layout of its own. This is the band a laptop actually sits in.

**Two hosts columns carry the same header.** `/compose` lists `Host` twice —
the given name and the system hostname are separate columns with the same
label. On a narrow window one of them is the first thing to leave the view, and
which one leaves is not obvious.

**The overview list repeats the hosts table.** `/overview` renders the same
eight columns as `/hosts` at 928 pixels. Whatever the compact and mobile
representations become, these two screens should not solve it twice.

### P2

**Controls are sized for a pointer at every width.** The smallest interactive
control measures 34 pixels on most screens, 28 on the row action menus of
`/containers` and `/agents`, 17 on `/hosts` and 13 on `/settings`. WCAG 2.2 AA
asks for 24 by 24, which the 34- and 28-pixel controls meet; the 17- and
13-pixel ones do not, and none of them reach the 40 to 44 pixels a thumb wants.

**Table widths are set by content, not by a scale.** Nine tables want nine
different widths between 704 and 1330 pixels. There is no shared notion of what
a column costs, so each screen finds its own breaking point.

**Breakpoints are ad hoc.** The stylesheet carries `min-width` rules at 640,
768, 900, 1024, 1100, 1280 and 1440 and a `max-width: 40rem`, grown per
component rather than declared once.

### P3

**Detail screens have no table to adapt.** Host detail, container detail, stack
create, logs and roles carry no table and hold at every width. They are listed
so the record is complete.

## Screen matrix

`ok` means no window overflow and nothing operational outside the view. `scroll`
means the table needs the window moved sideways. `overflow` means the page
itself scrolls.

| Screen | 375 | 600 | 768 | 1024 | 1440 |
| --- | --- | --- | --- | --- | --- |
| Overview | scroll | scroll | scroll | scroll | ok |
| Hosts | scroll | scroll | scroll | scroll | **scroll** |
| Host detail | ok | ok | ok | ok | ok |
| Agents | scroll | scroll | scroll | scroll | ok |
| Containers | scroll | scroll | scroll | scroll | **scroll** |
| Container detail | ok | ok | ok | ok | ok |
| Container create | ok | ok | ok | ok | ok |
| Stacks | ok | ok | ok | ok | ok |
| Stack create | ok | ok | ok | ok | ok |
| Compose | scroll | scroll | scroll | ok | ok |
| Logs | ok | ok | ok | ok | ok |
| Actions | scroll | scroll | scroll | scroll | ok |
| Audit | scroll | scroll | scroll | scroll | ok |
| Users | scroll | scroll | scroll | scroll | ok |
| Roles | ok | ok | ok | ok | ok |
| Settings | **overflow** | **overflow** | ok | ok | ok |
| Login | ok | ok | ok | ok | ok |

Login was measured signed out; signed in it redirects to the overview.

## Tables

Width is what the table wants. *Fits from* is the viewport width at which it
first fits beside the sidebar.

| Table | Width | Fits from | Columns |
| --- | --- | --- | --- |
| Hosts | 1330 | above 1440 | Host, Status, OS / Version, Containers, CPU, Memory, Disk, Agent, Last seen |
| Containers | 1184 | ~1500 | Name, Host, Image, Managed by, Status, Health, Restarts, Uptime, Actions |
| Audit | 1041 | 1440 | Time, Actor, Action, Target, Result, Source, Request ID |
| Actions | 992 | 1440 | Requested, Operation, Container, Host, Actor, Result, Duration |
| Agents | 949 | 1440 | Host, Agent ID, Version, Protocol, Status, Last seen, Actions |
| Overview | 928 | 1440 | Host, Status, Containers, CPU, Memory, Disk, Uptime, Last seen |
| Users | 832 | 1440 | User, Status, MFA, Last login |
| Compose | 736 | 1024 | Project, Host, State, Services, Host, Last observed |
| Settings | 704 | 768 | Client, Signed in, Last seen, Expires, Actions |

### Column priorities

**P0** must be visible wherever the list is shown. **P1** is wanted whenever
there is room. **P2** may move to a second line or an expander. **P3** belongs
on the detail page.

**Containers**

| Column | Priority | Desktop | Compact | Mobile | Why |
| --- | --- | --- | --- | --- | --- |
| Name | P0 | ✓ | ✓ | primary line | what it is |
| Host | P0 | ✓ | ✓ | secondary line | six identities share a hostname |
| Status | P0 | ✓ | ✓ | ✓ | whether it is running |
| Health | P0 | ✓ | ✓ | ✓ | carries the last-known marker |
| Actions | P0 | ✓ | ✓ | menu | the reason for the list |
| Image | P1 | ✓ | truncated | expander | identifies the workload |
| Managed by | P1 | ✓ | ✓ | expander | stack or by hand |
| Uptime | P2 | ✓ | — | expander | context |
| Restarts | P2 | ✓ | — | expander | context |

**Hosts**

| Column | Priority | Desktop | Compact | Mobile | Why |
| --- | --- | --- | --- | --- | --- |
| Host | P0 | ✓ | ✓ | primary and secondary line | given name over system hostname |
| Status | P0 | ✓ | ✓ | ✓ | reachable or last known |
| Containers | P1 | ✓ | ✓ | ✓ | the one number that says what it carries |
| CPU / Memory / Disk | P1 | ✓ | one combined | expander | three columns for three numbers |
| Last seen | P1 | ✓ | ✓ | with status | meaning of a stale reading |
| OS / Version | P2 | ✓ | — | expander | rarely acted on |
| Agent | P2 | ✓ | — | expander | version belongs with version visibility |

**Agents**

| Column | Priority | Desktop | Compact | Mobile | Why |
| --- | --- | --- | --- | --- | --- |
| Host | P0 | ✓ | ✓ | primary line | which machine |
| Status | P0 | ✓ | ✓ | ✓ | connected, disconnected, revoked |
| Actions | P0 | ✓ | ✓ | menu | revoking is done here |
| Version | P1 | ✓ | ✓ | expander | the mismatch view will want it |
| Last seen | P1 | ✓ | ✓ | with status | |
| Agent ID | P2 | ✓ | truncated | expander | long, rarely read in full |
| Protocol | P3 | ✓ | — | detail page | |

**Audit and Actions** — history rather than operation: Time, Actor, Action and
Result are P0; Target and Operation P1; Source, Request ID and Duration P2, and
belong in an expanded row.

**Users, Settings, Compose** — narrow enough to survive a compact layout intact.
Settings needs its sessions table to scroll inside its own box rather than
pushing the page.

## Touch

Measured heights of the smallest interactive control:

| Screen | Smallest | Note |
| --- | --- | --- |
| Settings | 13 | below the 24-pixel minimum |
| Hosts | 17 | below the 24-pixel minimum |
| Containers, Agents | 28 | row action menu |
| Everything else | 34 | the standard control height |

For narrow layouts the primary interactive controls should reach roughly 40 to
44 pixels of usable height, and the two controls under 24 pixels should be
raised at every width. Desktop controls do not need to grow.

## Where version information would sit

Recorded for the later phase; nothing is built.

The data is already there and needs no external call: the control server
reports its version, commit, protocol and schema; each host carries its agent
version and Docker version. The demo shows five different agent versions across
six hosts, so a mismatch view has something to say from the first day.

Placements that the audit found room for, in order of how well they fit:

- **Settings** — a components panel: control server, web, schema, protocol, and
  the agent versions in use. Room at every width.
- **Agents** — the Version column is P1 and already present; a mismatch marker
  belongs next to it rather than in a new column.
- **Hosts** — the Agent column is P2 and drops out of the compact layout, so a
  version warning must not live only there.
- **Overview** — one line when something is out of step, nothing when it is not.

An available-version provider stays off unless an administrator turns it on,
runs server-side, is cached, sends no telemetry, and its failure must not affect
anything else.

## Phase 2 backlog

Grouped by cause. One fix per group serves several screens; the screen-specific
work is what is left after the shared work lands.

1. **Shared table, compact mode** — column priorities per screen, secondary data
   into a second line or an expander. Serves overview, hosts, containers,
   agents, actions, audit, users. Removes both P0 findings on the wide lists and
   the compact-band P1.
2. **Shared list row below 900** — the compact representation, driven by the
   same priorities. Serves the same screens.
3. **Row actions in the compact and mobile forms** — an action menu that is
   reachable without moving the window. Removes the row-action P1.
4. **Settings sessions table** — scroll inside its own box. Removes the settings
   P0.
5. **Touch sizing on narrow viewports** — raise primary controls towards 40 to
   44 pixels, and the two controls under 24 pixels at every width.
6. **Declare the breakpoints once** — replace the seven ad hoc widths with the
   five classes above.
7. **Screen-specific** — the duplicate Host header on Compose, and deciding
   whether the overview keeps its own list or reuses the hosts one.

## Resolutions

What was built against the findings above, and what the same eighty-five
measurements say now. The findings themselves are left as they were recorded
against 0.2.0; this section is the answer to them, not a revision of them.

The re-measurement uses the same seventeen screens at the same five widths, run
against the implementation with real data — seven host identities and nine
containers created by the browser suites. Verdicts are read the same way both
times: `overflow` if the document scrolls sideways, `scroll` if a table needs
the window moved to be read, `ok` otherwise.

| | Before | After |
| --- | --- | --- |
| ok | 45 | **85** |
| scroll | 38 | **0** |
| overflow | 2 | **0** |

### P0 · Operational columns leave the window on the two widest lists

**Fix.** Every column now carries the priority of what it tells an operator, and
the width that decides which are shown is the table's own rather than the
window's. Three layouts follow: the full table above 76rem of table width, a
compact table that keeps P0 and P1 below it, and a stacked list below 40rem.

**Verification.** `/containers` and `/hosts` measure `ok` at all five widths;
the table is given exactly the width it wants at each (341, 566, 718, 734,
1150). The responsive suite asserts that name, host and status are inside the
window on every one. Nine tables are covered by
`app/src/app/ui/table/column-priority.spec.ts`, which fails if a heading and its
cell disagree about priority.

**Status.** Resolved.

### P0 · Settings scrolls the window sideways

**Fix.** The sessions table was the one list not using the shared table pattern,
so none of the priority rules reached it. It carries `dp-table` now.

**Verification.** Page overflow at 375 fell from 292 pixels to 0, and at 600
from 67 to 0. Measured again after the change with every element on the page
checked against the window: nothing extends past it.

**Status.** Resolved.

### P1 · Row actions are unreachable on narrow windows

**Fix.** The actions cell is P0 and, in the stacked layout, sits on the first
line beside the resource name.

**Verification.** No screen reports an unreachable row action at any width. In
the stacked layout the menu trigger measures 44 by 44.

**Status.** Resolved.

### P1 · The compact band has no design

**Fix.** The band between a tablet and a wide desktop is the compact table: P0
and P1 columns, P2 and P3 dropped.

**Verification.** `ok` at 768 and 1024 on every list, where all seven lists
previously scrolled.

**Status.** Resolved.

### P1 · Two hosts columns carry the same header

**Fix.** The second column is `System hostname` and is P2, so it is the first to
go when the table narrows.

**Status.** Resolved.

### P1 · The overview list repeats the hosts table

**Fix.** Neither screen carries responsive code of its own. Both mark their
columns and inherit the same three layouts, so the compact and stacked forms are
defined once.

**Status.** Resolved for the responsive behaviour. Whether the overview should
render the hosts table component rather than its own markup is a component
question and stays open.

### P2 · Controls are sized for a pointer at every width

**Fix.** The sort control in a table heading was the label's own height with no
room around it; it now carries padding that the surrounding negative margin
takes back out of the layout, so the target grew without moving the header. The
row menu trigger is 44 by 44 in the stacked layout.

**Verification.** No control under 24 pixels on any of the eighty-five
measurements. The smallest is 28 — the row menu on wide layouts, which meets
WCAG 2.2 AA and is a pointer target rather than a thumb one.

**Correction to the record above.** The 13-pixel reading on Settings was a
measurement fault, not a fault in the product: it is a radio input inside a
36-pixel label, and the label is what a person hits. The measurement now reports
the effective target. Nothing about that control changed, and it was never
below the minimum.

**Status.** Resolved for the sort control. The 40-to-44-pixel aspiration is met
by the row menu in the stacked layout and not pursued for the rest.

### P2 · Table widths are set by content, not by a scale

**Fix.** Partial. A table's minimum width now applies only in the full layout;
below it the priorities decide what is shown, so the number no longer sets a
breaking point.

**Status.** Open. Nine tables still declare nine widths.

### P2 · Breakpoints are ad hoc

**Status.** Open. The table layouts are driven by three container widths
declared once, but the seven `min-width` rules the finding names are in eleven
component stylesheets covering cards, forms and the top bar, and consolidating
them would change layout well outside the lists.

### P3 · Detail screens have no table to adapt

**Status.** Unchanged and still `ok` at every width.

### Accessibility of the stacked layout

Changing `display` on a table is normally where its semantics are lost, which
would make the stacked list a run of text with no row boundaries. Asked of the
browsers rather than assumed: Chromium, Firefox and WebKit all expose `table`,
`rowgroup`, `row`, `rowheader` and `cell` for the stacked layout, so no ARIA
roles are needed to hold the semantics up.

The column headers are removed along with the columns they head, so no heading
is left describing something that is not shown. Focus order matches the visual
order: the only controls a row leaves visible are the identifier and the row
action, and nothing focusable is placed between them. No identifiers were added,
so no element carries a duplicated one.

## Related

- [App UI Spec](APP_UI_SPEC.md)
- [Component Spec](COMPONENT_SPEC.md)
- [Known Limitations](../reference/known-limitations.md)
