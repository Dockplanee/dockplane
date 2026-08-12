# The Dockplane control server.
#
# Three stages, so that the image that runs in production carries the compiled
# server and its production dependencies and nothing else: no sources, no test
# suite, no build tooling, no package manager cache.

ARG NODE_VERSION=22.23.2

# --- Production dependencies ------------------------------------------------
#
# Built for the image being produced, not for the machine producing it: the
# password hashing library is a native module with a package per platform, and
# an architecture's worth of the wrong binary would fail the first time somebody
# signed in.
#
# Only the production set is installed here. The build toolchain is not part of
# it, which is why this stage does not run esbuild — the one thing that made an
# emulated install fail.
FROM node:${NODE_VERSION}-bookworm-slim AS production-deps

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Build ------------------------------------------------------------------
#
# On the machine doing the building. TypeScript compiles to JavaScript that is
# the same whichever architecture produced it, and the toolchain that compiles
# it has no business running under emulation.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build

WORKDIR /build

COPY package.json package-lock.json tsconfig.json tsconfig.build.json nest-cli.json ./
RUN npm ci

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

COPY --from=production-deps /build/node_modules ./node_modules
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
