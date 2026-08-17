# The Dockplane browser application, served by Caddy.
#
# The application is static once built, so the runtime image is Caddy with the
# compiled assets and no Node runtime at all. Caddy is also what terminates
# public TLS and proxies the API, which is why there is no separate web server
# in the stack.

# Base images are pinned by digest as well as by tag.
#
# A tag is a name the registry may move: the same `2.11.4-alpine` can be
# republished when its distribution patches a library, and a build of an
# unchanged commit would then produce different bytes. The digest is what makes
# an image an input rather than a lookup, so rebuilding a release is a function
# of the commit and nothing else.
#
# Updating one is a commit: raise the version, resolve the new digest, rebuild,
# scan, and let the release gates judge the result. That is what makes a change
# to what the image carries something a person decided and a reviewer can see.

ARG NODE_VERSION=22.23.2
ARG NODE_DIGEST=sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
ARG CADDY_VERSION=2.11.4
ARG CADDY_DIGEST=sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648
ARG ALPINE_VERSION=3.24.1
ARG ALPINE_DIGEST=sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

# --- Build ------------------------------------------------------------------
#
# Pinned to the machine doing the building rather than to the image being built.
# What leaves this stage is compiled JavaScript, CSS and HTML, which is the same
# whichever architecture produced it — and building it under emulation buys
# nothing while costing a great deal: the toolchain writes native binaries and
# runs them immediately, which under QEMU races into ETXTBSY.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim@${NODE_DIGEST} AS build

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# What the bundle says it is.
#
# The browser application is its own artefact, and an operator who pins the two
# images to different tags is running two revisions. So the version is compiled
# in here rather than read from the runtime container's environment, which the
# browser never sees: the assets are static files behind Caddy, and a variable
# set beside them reaches nobody.
#
# Both are release facts rather than build facts — no clock, no host, no path —
# so the same source at the same version still produces the same bytes.
ARG DOCKPLANE_VERSION=0.0.0-dev
ARG DOCKPLANE_COMMIT=unknown

# The assets under public/ are copied into the output untouched, modification
# time and permissions included, and both are properties of the checkout rather
# than of the commit: git records only whether a file is executable, and the
# time is when that checkout was made. Stamping the output with the time the
# build ran puts those files in the same position as everything the compiler
# wrote — later than the commit, and so rewritten to it when the image is
# exported — and fixed permissions leave nothing of the umask behind.
RUN npm run build \
	&& find dist -type d -exec chmod 0755 {} + \
	&& find dist -type f -exec chmod 0644 {} + \
	&& find dist -exec touch {} +

# --- Runtime ----------------------------------------------------------------
# --- Caddy ------------------------------------------------------------------
#
# Read for one file. The published Caddy image is the project's own build of the
# server, pinned by digest, and taking the binary out of it is what makes that
# build an input here rather than a base to inherit everything else from.
FROM caddy:${CADDY_VERSION}-alpine@${CADDY_DIGEST} AS caddy-source

# --- Runtime ----------------------------------------------------------------
#
# A pinned distribution image, and only what serving the application needs.
#
# Caddy's own image carries curl, libcurl and c-ares, which Dockplane uses for
# nothing: the binary is statically linked and the health check is busybox's
# wget. They arrived with the base and stayed, and between them they accounted
# for every fixable finding this image reported that the distribution had
# already patched. Not installing them is a better answer than upgrading them.
#
# Nothing here asks a package repository anything. The distribution is pinned by
# digest and raised deliberately, so the same commit builds the same bytes for
# as long as the pins say so.
FROM alpine:${ALPINE_VERSION}@${ALPINE_DIGEST} AS runtime

COPY --from=caddy-source /usr/bin/caddy /usr/bin/caddy

# The MIME table Go consults when serving files. Without it a font or a web
# manifest leaves as application/octet-stream, which a browser will not use.
COPY --from=caddy-source /etc/mime.types /etc/mime.types

# The directories Caddy expects, taken from the image that defines them rather
# than created here: a command in this stage would run under emulation whenever
# the image's architecture is not the machine's own.
COPY --from=caddy-source /config /config
COPY --from=caddy-source /data /data
COPY --from=caddy-source /etc/caddy /etc/caddy

# Where Caddy keeps its configuration and its certificates, both volumes in the
# deployment. Named the same way the published image names them, because the
# deployment mounts them by those paths.
ENV XDG_CONFIG_HOME=/config \
    XDG_DATA_HOME=/data

ARG DOCKPLANE_VERSION=0.0.0-dev
ARG DOCKPLANE_COMMIT=unknown
ARG DOCKPLANE_BUILD_DATE=unknown

LABEL org.opencontainers.image.title="Dockplane Web" \
      org.opencontainers.image.description="Dockplane control plane application and reverse proxy" \
      org.opencontainers.image.source="https://github.com/Dockplanee/dockplane" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${DOCKPLANE_VERSION}" \
      org.opencontainers.image.revision="${DOCKPLANE_COMMIT}" \
      org.opencontainers.image.created="${DOCKPLANE_BUILD_DATE}"

ENV DOCKPLANE_VERSION=${DOCKPLANE_VERSION} \
    DOCKPLANE_COMMIT=${DOCKPLANE_COMMIT} \
    DOCKPLANE_BUILD_DATE=${DOCKPLANE_BUILD_DATE}

COPY --from=build /build/dist/dockplane-app/browser /srv/dockplane

# The Caddyfile is mounted by the deployment rather than baked in: it carries
# the operator's domain, and a change to it should not require a new image.

EXPOSE 80 443

WORKDIR /srv

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
