# =============================================================================
# API service — production image (node:20-alpine, NODE_ENV=production)
# =============================================================================
# Build context: the REPOSITORY ROOT (see `api.build` in docker-compose*.yml).
# Every COPY path below is therefore repo-root-relative.
#
# The server is one workspace of the root npm monorepo, so its dependency
# versions are pinned by the ROOT package-lock.json — the same lockfile CI
# installs from and Dependabot maintains. This image installs straight from
# that lockfile with a strict `npm ci`, which makes the image reproducible
# from any given commit. There is no per-service lockfile that can silently
# drift out of sync with the workspace.
# =============================================================================

# --- production dependencies -------------------------------------------------
FROM node:26-alpine AS deps
WORKDIR /app
# Root manifest + authoritative lockfile, plus every workspace package.json:
# npm needs all of them present to validate the lockfile, even though only
# the server workspace is installed here.
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
# `prepare` runs husky, a dev-machine git-hook installer with no place in an
# image build; drop it so `npm ci` does not try to exec the (uninstalled,
# root-only devDependency) husky binary.
RUN npm pkg delete scripts.prepare \
 && npm ci --workspace project-13-server --omit=dev --no-audit --no-fund \
 && mkdir -p /app/server/node_modules

# --- build (devDependencies needed for tsc) ---------------------------------
FROM node:26-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm pkg delete scripts.prepare \
 && npm ci --workspace project-13-server --no-audit --no-fund
COPY server/tsconfig.json ./server/tsconfig.json
COPY server/src ./server/src
RUN npm run build --workspace project-13-server

# --- runtime -----------------------------------------------------------------
FROM node:26-alpine AS runner
RUN addgroup -g 1001 -S app && adduser -S app -u 1001 -G app
WORKDIR /app/server
# Production dependency tree, exactly as resolved from the workspace lockfile.
# Hoistable packages live in the workspace-root node_modules; the server-level
# node_modules (usually empty) carries anything npm could not hoist.
COPY --from=deps    /app/node_modules         /app/node_modules
COPY --from=deps    /app/server/node_modules  ./node_modules
COPY --from=builder /app/server/package.json  ./package.json
COPY --from=builder /app/server/dist          ./dist

# Version stamp for GET /version. ARGs are wired by docker-compose from the
# repo VERSION file; written to env so the running process can read them
# without touching the filesystem.
ARG APP_VERSION=dev
ARG GIT_SHA=
ARG BUILT_AT=
ENV APP_VERSION=${APP_VERSION}
ENV GIT_SHA=${GIT_SHA}
ENV BUILT_AT=${BUILT_AT}

RUN chown -R app:app /app
USER app
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
