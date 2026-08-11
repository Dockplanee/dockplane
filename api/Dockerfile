# The Dockplane control server.
#
# Three stages, so that the image that runs in production carries the compiled
# server and its production dependencies and nothing else: no sources, no test
# suite, no build tooling, no package manager cache.

ARG NODE_VERSION=22.23.2

# --- Dependencies -----------------------------------------------------------
# Separate from the build so that a change to the source does not reinstall.
FROM node:${NODE_VERSION}-bookworm-slim AS dependencies

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && cp -R node_modules /production-modules && npm ci

# --- Build ------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build

WORKDIR /build

COPY --from=dependencies /build/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

# Source maps and declaration files describe the layout of the source tree and
# are of no use to a running server, so the runtime image does not carry them.
RUN npm run build \
	&& find dist -name '*.js.map' -delete \
	&& find dist -name '*.d.ts' -delete

# --- Runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG DOCKPLANE_VERSION=0.0.0-dev
ARG DOCKPLANE_COMMIT=unknown
ARG DOCKPLANE_BUILD_DATE=unknown

LABEL org.opencontainers.image.title="Dockplane Control Server" \
      org.opencontainers.image.description="Control plane API and agent gateway for Dockplane" \
      org.opencontainers.image.source="https://github.com/Dockplanee/dockplane" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${DOCKPLANE_VERSION}" \
      org.opencontainers.image.revision="${DOCKPLANE_COMMIT}" \
      org.opencontainers.image.created="${DOCKPLANE_BUILD_DATE}"

# Baked in rather than read at runtime: a deployment must be able to say which
# code it is running without reference to the repository it came from.
ENV NODE_ENV=production \
    DOCKPLANE_VERSION=${DOCKPLANE_VERSION} \
    DOCKPLANE_COMMIT=${DOCKPLANE_COMMIT} \
    DOCKPLANE_BUILD_DATE=${DOCKPLANE_BUILD_DATE}

# The runtime runs `node`, and nothing else. npm ships its own vendored
# dependency tree inside the base image, which is a supply of vulnerabilities
# for code this image never executes.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

COPY --from=dependencies /production-modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json ./

# The image ships no writable state. Everything durable — the certificate
# authority, the gateway key pair — is mounted in, and the container is
# expected to run with a read-only root filesystem.
USER node

EXPOSE 3000 9443

# The process is PID 1 under an init supplied by the runtime, so SIGTERM
# reaches node directly and the server can close its listeners and streams.
CMD ["node", "dist/main.js"]
