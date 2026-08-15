# The Dockplane browser application, served by Caddy.
#
# The application is static once built, so the runtime image is Caddy with the
# compiled assets and no Node runtime at all. Caddy is also what terminates
# public TLS and proxies the API, which is why there is no separate web server
# in the stack.

ARG NODE_VERSION=22.23.2
ARG CADDY_VERSION=2.11.4

# --- Build ------------------------------------------------------------------
#
# Pinned to the machine doing the building rather than to the image being built.
# What leaves this stage is compiled JavaScript, CSS and HTML, which is the same
# whichever architecture produced it — and building it under emulation buys
# nothing while costing a great deal: the toolchain writes native binaries and
# runs them immediately, which under QEMU races into ETXTBSY.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

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
FROM caddy:${CADDY_VERSION}-alpine AS runtime

# The distribution's own security updates, from its own repositories.
#
# Caddy publishes an image per release and does not rebuild it when Alpine
# patches a library inside it, so an image pinned to the newest Caddy still
# carries whatever its base held on the day it was built. This applies what
# Alpine has published since, and pins nothing by hand: mixing distributions or
# picking individual package versions out of a repository is how a base image
# becomes something nobody can reason about.
#
# It costs bit-for-bit reproducibility across time — the same Dockerfile builds
# different bytes once Alpine publishes an update. That is what applying
# security updates means; the release manifest records the digest that was
# actually published.
#
# The cache directory is a scratch mount for the length of the command and is
# not part of the layer, for the same reason as in the control server's image:
# a command in this stage runs under emulation whenever the image's
# architecture is not the machine's own, and an emulator writes its translation
# cache into the filesystem it is running in.
#
# The package manager's log records when it ran, so it is removed in the same
# command: a later one would only add a whiteout over bytes the image already
# carries.
RUN --mount=type=tmpfs,target=/root/.cache \
	apk upgrade --no-cache \
	&& rm -f /var/log/apk.log

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
