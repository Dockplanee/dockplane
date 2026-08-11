# The Dockplane browser application, served by Caddy.
#
# The application is static once built, so the runtime image is Caddy with the
# compiled assets and no Node runtime at all. Caddy is also what terminates
# public TLS and proxies the API, which is why there is no separate web server
# in the stack.

ARG NODE_VERSION=22.23.2
ARG CADDY_VERSION=2.11.4

# --- Build ------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Runtime ----------------------------------------------------------------
FROM caddy:${CADDY_VERSION}-alpine AS runtime

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
