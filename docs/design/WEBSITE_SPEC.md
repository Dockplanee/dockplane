# Dockplane Public Website

How the public website is put together: its purpose, its pages, and the rules
the implementation is held to.

## Content Source

The approved wording lives in one place:

```text
docs/design/WEBSITE_COPY.md
```

This file describes structure, layout and delivery. It does not repeat the copy:
two copies of a sentence means one of them goes stale.

Do not rewrite the product voice into generic SaaS marketing unless the product
positioning actually changes.

## Purpose

The public website is deployed independently of the authenticated Dockplane
application and does not depend on a running control server.

Its goals:

- explain Dockplane within seconds
- explain the security model
- communicate the multi-host Docker focus
- provide documentation and installation entry points
- provide source and release links when they exist
- stay useful while a Dockplane instance is down for maintenance

## Positioning

Tagline:

> **Your Docker hosts. One control plane.**

Short description:

> Dockplane is a self-hosted control plane for managing Docker across multiple
> hosts.

Dockplane is intentionally Docker-focused. Avoid vague slogans such as
"infrastructure reimagined", "the future of DevOps" or "next-generation
cloud-native orchestration".

## Primary Language

English. Content and routing are designed so localization can be added later
without rewriting core components.

## Navigation

```text
Dockplane

Product
Features
Security
Docs
Changelog

[ Get Started ]
```

`Product` is the narrative overview. `Features` is the detailed capability
catalogue grouped by product area, and is also where planned capabilities and
the explicit non-goals are listed.

Source and release navigation appears only when the destination exists. Do not
ship dead links.

## Routes

```text
/
/product
/features
/security
/docs
/changelog
```

Every route above is prerendered and listed in the sitemap. The 404 document is
prerendered at `/404` so static hosting can serve it for unknown addresses; it
is excluded from the sitemap and marked `noindex`. A `robots.txt` is served
alongside them.

## Page Structure

Sections carry a two-digit index beside the eyebrow. The index is a position on
the page, so it is derived where a page's sections come from a list rather than
written by hand: a section inserted into a hand-numbered page has twice gone out
with two sections claiming the same number.

### Home

A hero carrying an eyebrow, a two-line heading, a body, a primary and a
secondary action, a supporting line and the overview visual. Then the numbered
sections:

1. Operations, with three supporting items
2. Multi-host, with the host fleet visual
3. Stacks, with the Compose project visual
4. Operational context, with the logs and events visual
5. Security, with four principles, the capability flow visual and a link to the
   security page
6. Versions, with three supporting items
7. Self-hosted, with three supporting items

Then the closing call to action, which is unnumbered.

### Product

Hero, then: hosts, containers, stacks, logs and events, permissions and audit,
versions, the interface screenshots, scope, and the closing call to action.

The containers and stacks sections are where ownership has to stay legible:
what Dockplane created, what it discovered, and what belongs to a stack are
three different things and are never merged into one sentence.

### Features

Hero with a jump list, one section per capability area, then the planned
section and the boundary section. The areas and their entries come from
`website/src/app/pages/features/feature-catalog.ts`, which follows
[Product Scope](../product/PRODUCT_SCOPE.md).

Planned capabilities are listed apart from the areas and carry no dates.

### Security

Hero, then: agent identity with the enrollment lifecycle, the capability model
with the capability flow visual, authorization, audit, Docker access, secrets,
and private reporting.

The reporting call to action renders only while a private reporting channel
exists.

### Docs

Hero with a panel saying where the documentation lives, the deployment
topology, the steps that connect a host, and an index of `docs/` generated on
every build.

### Changelog

Hero, then the releases, generated from `CHANGELOG.md`. A release without a
date renders as not released.

## Product Visuals

The visual focus is the product itself, in two forms.

**Curated interface previews** are built from the site's own components with
synthetic data, and are the primary visuals. They may show only views and
actions that exist in the current release, and they carry a caption saying what
they are.

**Screenshots** are captures from a running installation, shown on the product
page beside the previews rather than in place of them. The data in them is
synthetic and the copy says so.

Do not use meaningless charts as decoration, and do not show fake stars, users,
logos, testimonials or download counts.

## Footer

Only destinations that exist. Recommended groups:

```text
Product
  Overview
  Features
  Security
  Changelog

Resources
  Documentation
  Releases

Project
  Security policy
  Source
  Issues
  License
```

## Visual Design

Use `BRAND_SPEC.md`.

- dark-first visual lead, with an equally good light mode
- generous whitespace
- maximum content width of roughly 1200 to 1320px
- two-column hero on large screens
- restrained borders, moderate radii, minimal shadow
- the product interface as the visual focus

Do not build a generic gradient-orb-and-three-cards SaaS landing page.

## Responsive

**Desktop.** Two-column hero, generous margins, large product visual.

**Tablet.** Fewer grid columns, diagrams still readable.

**Mobile.** Single column, accessible navigation, nothing essential behind a
hover, deliberate cropping of previews, and horizontally scrollable code where
a line cannot break.

## Accessibility

Target WCAG 2.2 AA where practical:

- keyboard navigation
- visible focus
- semantic heading hierarchy, one level-one heading per page and no skipped
  levels
- sufficient contrast
- meaningful alternative text
- reduced motion
- clear link labels

## SEO

Each route carries its own document title and description, rendered verbatim
without an appended site suffix. They describe the page in the same voice as
the page. The title in `index.html` is the pre-hydration fallback, not the
homepage title.

Structured data is limited to what the project can stand behind: that these
addresses are one site, and what the software is. No version, release date,
price or rating.

Natural relevant terms:

- self-hosted Docker management
- multi-host Docker management
- Docker dashboard
- Docker Compose management
- Docker host management
- self-hosted container management

Do not keyword-stuff.

## Technical Delivery

- Angular
- TailwindCSS
- prerendered, and independently deployable
- no database dependency for the public pages
- no mandatory analytics
- CSP-compatible
- no secrets in the frontend bundle

Generated files are written by the build from their sources and are never
edited by hand.

## Content Integrity

Never:

- advertise unimplemented functionality as available
- invent adoption metrics, customer evidence or security certifications
- claim a security property the product does not have
- publish placeholder text
- expose internal implementation history

## Related

- [Website Copy](WEBSITE_COPY.md)
- [Brand Specification](BRAND_SPEC.md)
- [Content Style](CONTENT_STYLE.md)
- [Product Scope](../product/PRODUCT_SCOPE.md)
