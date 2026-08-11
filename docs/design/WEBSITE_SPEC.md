# Dockplane Public Website

## Content Source

Approved baseline copy is maintained in:

```text
docs/design/WEBSITE_COPY.md
```

Do not rewrite the product voice into generic SaaS marketing unless the actual product positioning changes.

## Purpose

The public Dockplane website is independent from the authenticated Dockplane application.

Its goals:
- explain Dockplane within seconds
- build trust
- explain the security model
- communicate the multi-host Docker focus
- provide documentation and installation entry points
- provide source/release links when they exist
- remain useful during Dockplane instance maintenance

## Positioning

Preferred tagline:

> **Your Docker hosts. One control plane.**

Short description:

> Dockplane is a self-hosted control plane for managing Docker across multiple hosts.

Longer description:

> Manage containers, Compose stacks, logs, health and operations across your Docker hosts from one secure, self-hosted interface.

Avoid vague slogans such as:
- Infrastructure reimagined
- Future of DevOps
- Next-generation cloud-native orchestration

Dockplane is intentionally Docker-focused.

## Primary Language

Use English as the primary public website language.

Design content and routing so localization can be added later without rewriting core components.

## Navigation

Recommended:

```text
Dockplane

Product
Features
Security
Docs
Changelog

[ Get Started ]
```

`Product` is the narrative overview. `Features` is the detailed capability catalogue, grouped by product area, and is also where planned capabilities and the explicit non-goals are listed.

Show GitHub/source navigation only when the real destination exists.

Do not ship dead links.

## Initial Routes

```text
/
 /product
 /features
 /security
 /docs
 /changelog
```

Also include:
- 404
- sitemap
- robots.txt where appropriate

The 404 document is prerendered at `/404` so static hosting can serve it for unknown addresses. It is excluded from the sitemap and marked `noindex`.

## Hero

Eyebrow:

```text
SELF-HOSTED DOCKER MANAGEMENT
```

Heading:

```text
Your Docker hosts.
One control plane.
```

Body:

```text
Manage containers, Compose stacks, logs, health and operations across your Docker hosts from one secure, self-hosted interface.
```

Primary action:

```text
Get Started
```

Secondary action, only when valid:

```text
View Source
```

Supporting line:

```text
Self-hosted · Multi-host · Security-first
```

Do not show fake:
- stars
- users
- logos
- testimonials
- download counts

## Hero Product Visual

Use a realistic Dockplane application preview.

Example content:

```text
Overview

4 Hosts
38 Containers
7 Compose Projects
1 Needs Attention

docker-01     Healthy       12 containers
docker-02     Healthy        8 containers
storage-01    Warning        6 containers
apps-01       Healthy       12 containers

Needs attention

paperless-db
Health check failing
docker-02
```

This may be a controlled design mockup until the real application UI exists.

Do not use meaningless charts as decoration.

## Section: No Host Hopping

Heading:

```text
Docker operations without host hopping.
```

Body:

```text
Stop jumping between SSH sessions and separate Docker endpoints. Dockplane gives connected hosts one consistent operational interface while keeping execution local to each machine through its agent.
```

Three supporting items:

### All hosts in one place
See workloads, health and resource state across connected Docker hosts.

### Operate safely
Use defined agent capabilities with backend permissions and audit history.

### Stay self-hosted
Run the control plane on infrastructure you control.

## Section: Multi-Host

Heading:

```text
Built for more than one Docker host.
```

Explain that multi-host is the default model.

Show:
- host status
- workload count
- agent status/version
- key health signals

## Section: Compose

Heading:

```text
Your Compose stacks, wherever they run.
```

Show a realistic Compose project card:

```text
Nextcloud
apps-01

nextcloud     Running
postgres      Running
redis         Running

3 / 3 healthy
```

Only show actions that exist in the current release.

## Section: Operational Context

Heading:

```text
Know what is happening before you touch it.
```

Show:
- logs
- CPU
- memory
- network
- state
- health
- recent events

Dockplane is not positioned as a Prometheus replacement.

## Section: Security

Heading:

```text
Remote control without a remote shell.
```

Body:

```text
Dockplane agents expose defined operational capabilities instead of an unrestricted command interface. Device identity, encrypted communication, authorization and audit history are part of the architecture from the start.
```

Principles:
- unique agent identity
- explicit capabilities
- resource permissions
- auditable operations

CTA:

```text
Read the security model
```

Never claim:
- unhackable
- 100% secure
- military-grade
- zero risk

## Section: Services

Only show this as available when implemented.

Heading:

```text
Think in applications, not just containers.
```

Explain higher-level grouping without hiding container detail.

## Section: Self-Hosted

Heading:

```text
Your control plane belongs on your infrastructure.
```

Points:
- self-hosted
- inspectable/transparent architecture
- ordinary Docker-based deployment when implemented

Do not claim open-source licensing unless the repository actually contains a chosen license and the project is distributed accordingly.

## Final CTA

Heading:

```text
Bring your Docker hosts together.
```

Body:

```text
Deploy Dockplane and manage your Docker environment from one self-hosted control plane.
```

## Footer

Only show existing destinations.

Recommended groups:

```text
Product
  Overview
  Security
  Changelog

Resources
  Documentation
  Releases

Project
  Security Policy
  Contributing
  Source (when public)
  License (when selected)
```

## Visual Design

Use `BRAND_SPEC.md`.

Website characteristics:
- dark-first visual lead
- excellent light mode
- generous whitespace
- max content width approximately 1200–1320px
- 2-column hero on large screens
- restrained borders
- moderate radii
- minimal shadow
- real product UI as the visual focus

Do not build a generic “gradient orb + three cards” SaaS landing page.

## Responsive

### Desktop
- 2-column hero
- generous margins
- large product visual

### Tablet
- reduce grid count
- preserve readable diagrams

### Mobile
- single column
- accessible nav
- no essential hover behavior
- intentional screenshot cropping
- horizontally scrollable code where needed

## Accessibility

Target WCAG 2.2 AA where practical.

Require:
- keyboard navigation
- visible focus
- semantic heading hierarchy
- sufficient contrast
- meaningful alt text
- reduced motion
- clear link labels

## SEO

Homepage title:

```text
Dockplane — Self-Hosted Multi-Host Docker Management
```

Meta description:

```text
Dockplane is a self-hosted control plane for managing containers, Compose stacks, logs, health and operations across multiple Docker hosts.
```

Natural relevant terms:
- self-hosted Docker management
- multi-host Docker management
- Docker dashboard
- Docker Compose management
- Docker host management
- self-hosted container management

Do not keyword-stuff.

## Technical Delivery

Preferred:
- Angular
- TailwindCSS
- SSR or prerendering
- independently deployable
- no database dependency for marketing pages
- privacy-friendly by default
- no mandatory analytics
- CSP-compatible
- no secrets in frontend bundles

## Content Integrity

Never:
- advertise unimplemented functionality as available
- invent adoption metrics
- invent customer evidence
- invent security certifications
- publish placeholder text
- expose internal implementation history
