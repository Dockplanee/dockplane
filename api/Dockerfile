# The Dockplane control server.
#
# Four stages, so that the image that runs in production carries the compiled
# server, its production dependencies and the Compose compiler, and nothing
# else: no sources, no test suite, no build tooling, no package manager cache.
#
# Built from the repository root rather than from api/, because the Compose
# compiler is a sibling of the server rather than part of it.

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
ARG GO_VERSION=1.26.6
ARG GO_DIGEST=sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36

# --- The Compose compiler ---------------------------------------------------
#
# Compose files are parsed by this, in a process of its own, inside the control
# server's container. It is not a service and has no port: the server writes a
# request to its standard input and reads one answer back.
#
# Cross-compiled on the machine doing the building and targeted at the
# architecture being produced, which is what keeps an emulated Go toolchain out
# of the build without shipping the builder's own architecture into the image.
# Static, so the runtime image needs no Go and no libc beyond its own.
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-bookworm@${GO_DIGEST} AS compose-compiler

ARG TARGETARCH

WORKDIR /build

COPY compose-compiler/go.mod compose-compiler/go.sum ./
RUN go mod download

COPY compose-compiler/ ./

RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -trimpath -ldflags '-s -w' \
	-o /out/dockplane-compose-compiler .

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
FROM node:${NODE_VERSION}-bookworm-slim@${NODE_DIGEST} AS production-deps

WORKDIR /build

COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev

# --- Build ------------------------------------------------------------------
#
# On the machine doing the building. TypeScript compiles to JavaScript that is
# the same whichever architecture produced it, and the toolchain that compiles
# it has no business running under emulation.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim@${NODE_DIGEST} AS build

WORKDIR /build

COPY api/package.json api/package-lock.json api/tsconfig.json api/tsconfig.build.json \
	api/nest-cli.json ./
RUN npm ci

COPY api/src ./src

# Source maps and declaration files describe the layout of the source tree and
# are of no use to a running server, so the runtime image does not carry them.

# The output is given fixed permissions as well as fixed content. Files the
# compiler only copies — the migrations are read at runtime, not compiled —
# keep the permissions they had in the build context, and those depend on the
# umask of whoever made that checkout: a clone and an export of one commit
# differ, because git records only whether a file is executable and leaves the
# rest to the extracting machine.
RUN npm run build \
	&& find dist -name '*.js.map' -delete \
	&& find dist -name '*.d.ts' -delete \
	&& find dist -type d -exec chmod 0755 {} + \
	&& find dist -type f -exec chmod 0644 {} + \
	&& install -D -m 0644 package.json /runtime/package.json

# --- Runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim@${NODE_DIGEST} AS runtime

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
#
# The cache directory is a scratch mount for the length of the command and is
# not part of the layer. A command in this stage runs on the architecture being
# built, under emulation whenever that is not the machine's own, and an emulator
# writes its translation cache into the filesystem it is running in: an amd64
# image built on Apple silicon carried /root/.cache/rosetta in this layer. A
# later stage deleting it would not help, because the bytes are already in this
# one.
RUN --mount=type=tmpfs,target=/root/.cache \
	rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

COPY --from=production-deps /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist

# Taken from the stage that built it rather than from the build context. A file
# copied out of the context carries the modification time it has on the machine
# doing the building, which is when that checkout was made and not a property of
# the commit — and timestamps are only rewritten downwards, so an older one
# survives into the layer. Everything a stage produces is written during the
# build and is stamped with the commit's date.
COPY --from=build /runtime/package.json ./

# Owned by root and executable by everyone, like the rest of the image: the
# server runs as `node` and only ever executes it.
COPY --from=compose-compiler --chmod=0755 /out/dockplane-compose-compiler \
	/usr/local/bin/dockplane-compose-compiler

# The image ships no writable state. Everything durable — the certificate
# authority, the gateway key pair — is mounted in, and the container is
# expected to run with a read-only root filesystem.
USER node

EXPOSE 3000 9443

# The process is PID 1 under an init supplied by the runtime, so SIGTERM
# reaches node directly and the server can close its listeners and streams.
CMD ["node", "dist/main.js"]
