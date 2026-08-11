# Dockplane Public Website

The public Dockplane website. It is built and deployed independently from the
Dockplane control server and has no runtime dependency on it.

## Stack

- Angular with standalone components and zoneless change detection
- TailwindCSS for utilities, with the design tokens defined in `src/styles`
- Static prerendering: `ng build` writes plain HTML for every route

The output is a static directory. No Node.js process is required at runtime.

## Commands

```bash
npm install
npm start           # development server
npm run build       # prerender all routes, then write robots.txt and sitemap.xml
npm test            # unit and accessibility tests
npm run lint        # ESLint, including template accessibility rules
npm run typecheck   # TypeScript only; templates are checked by the build
npm run format      # Prettier
```

`npm run build` writes to `dist/dockplane-website/browser`. Serve that directory
as static files.

## Deployment

Serve `dist/dockplane-website/browser` as static files. Ready-made
configurations are in `deploy/`:

```text
deploy/nginx.conf   include in a TLS-terminating server block
deploy/Caddyfile    complete site block
```

Both handle the two things a naive static setup gets wrong:

- Directory URLs (`/product`) must resolve to `product/index.html`.
- Unknown addresses must answer with **HTTP 404** and the generated
  `404/index.html`. A server that returns 200 lets unknown URLs be indexed.

They also set cache headers (content-hashed assets immutable, HTML revalidated)
and a restrictive CSP. The site loads no third-party resources and contains no
inline scripts, styles or event handlers, so this policy holds:

```text
default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'
```

## Configuration

`src/app/core/site.config.ts` holds the deployment origin and every external
destination. A destination set to `null` does not exist yet: navigation entries,
footer entries and calls to action that point at it are omitted rather than
rendered as a dead link. Set the value once the real URL exists.

`SITE_ORIGIN` is used for canonical URLs, the sitemap and social metadata, and
must match the host the site is served from.

The security page links to GitHub's private vulnerability reporting form. That
link only works once **Private vulnerability reporting** is enabled under the
repository's Settings → Security.

## Changelog

The changelog page is generated from `CHANGELOG.md` in the repository root, so
release notes are maintained in one place. `npm run build`, `npm start` and
`npm test` regenerate it automatically; run it on its own with:

```bash
npm run changelog:sync
```

Headings follow `## <version>` (optionally with an ISO date) and `### Added`,
`### Changed`, `### Fixed`, `### Removed` or `### Security`. An unknown section
name fails the build rather than being dropped silently.

## Brand assets

`public/favicon.svg`, `public/favicon.ico` and `public/apple-touch-icon.png` are
generated from the compact form of the mark. `public/social-card.png` is
rendered from `branding/social-card.html` at 1200x630:

```bash
chrome --headless --hide-scrollbars --window-size=1200,630 --screenshot=public/social-card.png branding/social-card.html
```

The lockup used in the interface lives in `src/app/ui/logo`, built from the same
geometry as the approved reference in `design-reference/`.

## Fonts

Inter and JetBrains Mono are served from `public/fonts` so the site makes no
third-party requests. Refresh them from their packages after a dependency
update:

```bash
npm run fonts:sync
```
