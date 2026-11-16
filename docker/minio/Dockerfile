# syntax=docker/dockerfile:1.7
#
# MinIO, built from source.
#
# Why this exists. Upstream stopped publishing: github.com/minio/minio and
# minio/mc were archived in April 2026, the last tag that shipped release
# binaries is RELEASE.2025-09-07, and `minio/minio` on Docker Hub was deleted.
# `image: minio/minio:RELEASE.2025-04-22T22-12-26Z` therefore no longer pulls on
# a fresh machine, and the one copy that still runs carried seven fixable
# CRITICAL findings (Go stdlib, google.golang.org/grpc, amqp091-go) that nobody
# will ever patch upstream. So we build the last upstream release ourselves,
# with a current Go toolchain and those dependencies bumped.
#
# What is pinned, and why it can be trusted. Both sources are fetched by COMMIT
# SHA, not by tag: a commit id is a hash of the whole tree, so the build cannot
# silently pick up different code if a tag is ever moved. The two commits are
# the tags RELEASE.2025-10-15T17-29-55Z (minio) and RELEASE.2025-08-13T08-35-41Z
# (mc), the last of each. The only departures from upstream are the `go get`
# lines below, and the Go toolchain used to compile.
#
# What stays identical to the official image, so this is a drop-in: the same
# UBI micro base, /usr/bin/minio + /usr/bin/mc (the compose healthcheck is
# `mc ready local`), the upstream docker-entrypoint.sh, the same *_FILE
# variables, /data as the volume, port 9000, running as root.
#
# AGPL-3.0: the corresponding source of everything in this image is the two
# upstream commits named below plus the dependency bumps in this file; the
# licenses are shipped in /licenses.
#
# To rebuild after a new Go / dependency advisory: bump GO_IMAGE or the
# *_VERSION args, change the image tag in the compose files (the -rN suffix),
# scan with Trivy, and read docker/minio/README.md before touching production —
# a newer MinIO rewrites the metadata on /data and cannot be rolled back
# without a copy of the volume.

ARG GO_IMAGE=golang:1.27.4-alpine
ARG BASE_IMAGE=registry.access.redhat.com/ubi9/ubi-micro:9.9

# ----------------------------------------------------------------------------
FROM ${GO_IMAGE} AS build

# git: the sources are fetched by commit. ca-certificates: TLS to github.com and
# to the Go module proxy.
RUN apk add --no-cache git ca-certificates

# GOTOOLCHAIN=local: a `toolchain` line in an upstream go.mod must never make Go
# download some other compiler — the one in GO_IMAGE is the one we vetted.
ENV GOTOOLCHAIN=local \
    CGO_ENABLED=0

# Upstream commits (the tags named in the header) and what we bump on top.
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
ARG MINIO_VERSION=2025-10-15T17:29:55Z
ARG MC_COMMIT=7394ce0dd2a80935aded936b09fa12cbb3cb8096
ARG MC_VERSION=2025-08-13T08:35:41Z
# Fixed versions for the findings that motivated this build.
ARG AMQP091_VERSION=v1.13.0
ARG GRPC_VERSION=v1.79.3

# --- minio ------------------------------------------------------------------
WORKDIR /src/minio
RUN git init -q . \
 && git remote add origin https://github.com/minio/minio.git \
 && git fetch -q --depth 1 origin "${MINIO_COMMIT}" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "${MINIO_COMMIT}"

RUN go get "github.com/rabbitmq/amqp091-go@${AMQP091_VERSION}" "google.golang.org/grpc@${GRPC_VERSION}"

# The version is passed explicitly (it names the release); gen-ldflags.go reads
# the commit id from git, which is why the checkout above keeps its .git.
RUN LDFLAGS="$(MINIO_RELEASE=RELEASE go run buildscripts/gen-ldflags.go "${MINIO_VERSION}")" \
 && go build -tags kqueue -trimpath -ldflags "${LDFLAGS}" -o /out/minio .

# --- mc (the healthcheck client, `mc ready local`) --------------------------
WORKDIR /src/mc
RUN git init -q . \
 && git remote add origin https://github.com/minio/mc.git \
 && git fetch -q --depth 1 origin "${MC_COMMIT}" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "${MC_COMMIT}"

RUN go get "google.golang.org/grpc@${GRPC_VERSION}"

RUN LDFLAGS="$(MC_RELEASE=RELEASE go run buildscripts/gen-ldflags.go "${MC_VERSION}")" \
 && go build -tags kqueue -trimpath -ldflags "${LDFLAGS}" -o /out/mc .

# --- build-time evidence, so a bad bump shows up in the log ------------------
RUN /out/minio --version && /out/mc --version \
 && go version -m /out/minio | grep -E '^/out/minio: |google.golang.org/grpc[[:space:]]|amqp091-go' \
 && go version -m /out/mc    | grep -E '^/out/mc: |google.golang.org/grpc[[:space:]]'

# ----------------------------------------------------------------------------
FROM ${BASE_IMAGE}

ARG MINIO_COMMIT
ARG MC_COMMIT
ARG MINIO_VERSION

LABEL org.opencontainers.image.title="minio (built from source)" \
      org.opencontainers.image.description="MinIO object storage, rebuilt from the last upstream release with current Go and patched dependencies" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="${MINIO_COMMIT}" \
      org.opencontainers.image.version="RELEASE.${MINIO_VERSION}" \
      io.onetothree.mc.revision="${MC_COMMIT}"

# The variables the official image sets, so an existing deployment that relies on
# any of them keeps working. Not carried over: MINIO_UPDATE_MINISIGN_PUBKEY, the
# key that verifies upstream's self-update binaries — there are no more of those,
# and a source build is updated by rebuilding this image.
ENV MINIO_ACCESS_KEY_FILE=access_key \
    MINIO_SECRET_KEY_FILE=secret_key \
    MINIO_ROOT_USER_FILE=access_key \
    MINIO_ROOT_PASSWORD_FILE=secret_key \
    MINIO_KMS_SECRET_KEY_FILE=kms_master_key \
    MINIO_CONFIG_ENV_FILE=config.env \
    MC_CONFIG_DIR=/tmp/.mc

COPY --from=build /out/minio /out/mc /usr/bin/
COPY --from=build --chmod=0755 /src/minio/dockerscripts/docker-entrypoint.sh /usr/bin/docker-entrypoint.sh
COPY --from=build /src/minio/LICENSE /licenses/minio/LICENSE
COPY --from=build /src/minio/CREDITS /licenses/minio/CREDITS
COPY --from=build /src/mc/LICENSE /licenses/mc/LICENSE
COPY --from=build /src/mc/CREDITS /licenses/mc/CREDITS

EXPOSE 9000
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/docker-entrypoint.sh"]
CMD ["minio"]
