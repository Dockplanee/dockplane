# Dockplane Brand Specification

## Brand Idea

Dockplane represents calm technical control over Docker workloads distributed across multiple hosts.

The visual language should feel:
- technical
- dependable
- controlled
- modern
- quiet
- precise
- self-hosted
- professional

Avoid:
- playful consumer-app styling
- navigation/location metaphors
- fitness/tracking iconography
- CPU/chip metaphors
- Docker-whale derivatives
- Kubernetes-like hexagon branding
- generic cloud icons
- excessive gradients
- glossy SaaS effects
- oversized rounded cards

## Approved Logo Direction

The approved visual reference is:

```text
design-reference/dockplane-logo-approved-reference.png
```

The mark uses a **Connected Blocks / Control Line** metaphor.

### Mark Anatomy

The approved direction contains:

- one horizontal mint control line
- circular mint endpoints on the left and right
- one central mint rounded controller block
- four muted gray connected workload/host blocks
- short, restrained connector paths from those blocks toward the central control line
- a balanced, symmetrical technical silhouette

The logo should read as:
- one control plane
- multiple attached Docker hosts/workloads
- centralized coordination

It should not read as:
- a CPU
- a route/map
- a fitness tracker
- a generic network topology diagram copied from vendor icon sets

### Production Asset

A simple SVG basis is provided at:

```text
design-reference/dockplane-mark.svg
```

It is a starting implementation of the approved idea, not a reason to disregard the approved visual reference.

## Wordmark

Preferred lockup:

```text
[mark] Dockplane
```

On dark surfaces:
- `Dock` uses near-white
- `plane` uses Dockplane Mint

On light surfaces:
- `Dock` uses the primary dark text color
- `plane` uses Dockplane Mint

The wordmark should use the primary UI typeface in a strong but not overly heavy weight.

Avoid custom letter distortions that hurt readability.

## Clear Space

Maintain at least the height of the central controller block around the complete logo lockup.

Do not place borders, text or other marks inside the clear-space area.

## Minimum Size

Icon-only:
- recommended minimum: 24px UI
- preferred: 32px or larger

Horizontal lockup:
- avoid widths below roughly 120px unless a dedicated compact lockup is created

At small sizes:
- preserve the central control line
- preserve the controller block
- simplify minor connector detail rather than shrinking it into noise

## Core Colors

### Dark

```text
Graphite          #0F1216
Slate             #1B212A
Steel             #2B313D
Border            #303945
Text Primary      #F4F7F8
Text Secondary    #93A1AB
```

### Brand

```text
Dockplane Mint        #22D3A6
Dockplane Mint Hover  #1DBD95
Dockplane Mint Soft   #123B32
Dockplane Mint Light  #A7F3D0
```

### Light

```text
Background        #F7F9FA
Surface           #FFFFFF
Elevated          #EEF2F4
Border            #D8E0E5
Text Primary      #10171C
Text Secondary    #5F6E78
```

### Accessible Accent on Light Surfaces

Dockplane Mint is a graphic color. On light backgrounds it does not reach the contrast required for text, so accent-colored text, links and focus rings on light surfaces use a deeper tint of the same family:

```text
Dockplane Mint Deep   #0B7A5E
```

Use it for text, link and focus treatments in the light theme. Keep Dockplane Mint itself for fills, the logo, and other non-text graphic elements in both themes.

### Operational Status

Brand color and operational status should remain conceptually separate even if both use green families.

```text
Healthy / Success  #34D399
Warning            #FBBF24
Critical           #F87171
Information        #60A5FA
Unknown / Neutral  #7F8A93
```

These values are tuned for dark surfaces. Light surfaces use darker equivalents of the same semantics so status text stays readable:

```text
Healthy / Success  #04785A
Warning            #92600B
Critical           #B42318
Information        #1A5FB4
Unknown / Neutral  #5F6E78
```

Do not rely on color alone for status. Pair each status with a text label and a distinct glyph shape.

## Typography

### Primary

Preferred:

```text
Inter Variable
```

Fallback:

```text
Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
```

### Monospace

Preferred:

```text
JetBrains Mono
```

Use for:
- hostnames
- container names
- image tags
- commands
- log output
- IDs where useful

Do not use monospace as the main marketing body font.

## Shape Language

```text
Small radius   6px
Medium radius  10px
Large radius   12px
```

Use borders and surface contrast before shadows.

Avoid 24–32px bubble-style card rounding.

## Shadows

Keep shadows restrained.

Dark UI depth should come mainly from:
- background levels
- 1px borders
- spacing
- subtle hover changes

## Icons

Use one consistent line-icon family in the product.

Icons should:
- be simple
- have consistent stroke
- remain legible at 16–20px
- support, not replace, text labels

Avoid mixing multiple icon families without a strong reason.

## Motion

Motion should indicate:
- state change
- hierarchy
- feedback

Avoid:
- looping decorative motion
- parallax
- floating cards
- animated gradient blobs
- simulated terminal typing

Respect `prefers-reduced-motion`.

## Dark / Light

Both themes are first-class.

The dark theme may be the visual lead, but the light theme must feel designed rather than inverted.

## Marketing vs Application

Website:
- more whitespace
- larger typography
- product storytelling
- polished screenshots/mockups

Application:
- denser
- faster
- table-oriented
- operational
- less decorative

The brand remains consistent through color, logo, typography, iconography and status language.
