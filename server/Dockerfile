# =============================================================================
# Project 13 API — production multi-stage (node:20-alpine, NODE_ENV=production)
# =============================================================================
FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund \
  || (echo '[deps] lockfile drift detected, regenerating...' \
      && npm install --package-lock-only --no-audit --no-fund \
      && npm ci --no-audit --no-fund)
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
RUN addgroup -g 1001 -S app && adduser -S app -u 1001 -G app
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Version stamp for GET /version. ARG wired by docker-compose from the
# repo VERSION file; written to env so the running process can read
# it without touching the filesystem.
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
