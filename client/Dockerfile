# Production: multi-stage build (deps → build → minimal runner)
FROM node:26-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
# postinstall (scripts/copy-vendor-assets.js) must exist for npm ci's lifecycle.
COPY scripts ./scripts
# Prefer deterministic `npm ci`, but if package-lock is out-of-sync with
# package.json (common after dependabot PRs or new feature deps that weren't
# pre-locked), self-heal by rebuilding the lockfile and retrying.  This keeps
# `./startup.sh update` idempotent across arbitrary dependency changes.
RUN npm ci --no-audit --no-fund \
  || (echo '[deps] lockfile drift detected, regenerating...' \
      && npm install --package-lock-only --no-audit --no-fund \
      && npm ci --no-audit --no-fund)

FROM node:26-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time public env (baked into client bundle; set via docker-compose `args:`)
ARG API_INTERNAL_URL
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_WS_ORIGIN
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
ARG NEXT_PUBLIC_GIPHY_API_KEY
ARG MINIO_PUBLIC_URL
ARG NEXT_PUBLIC_DR_ENABLED=1
# Build stamp. next.config.js falls back to reading ../VERSION, but the build
# CONTEXT here is ./client, so that path does not exist inside the image and the
# client silently shipped as "dev" — which is exactly the value version-check.ts
# refuses to compare (`CLIENT_VERSION !== 'dev'`), so the update banner could
# never fire in production. Pass it explicitly.
ARG NEXT_PUBLIC_APP_VERSION
ENV NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION
ENV API_INTERNAL_URL=$API_INTERNAL_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_WS_ORIGIN=$NEXT_PUBLIC_WS_ORIGIN
ENV NEXT_PUBLIC_VAPID_PUBLIC_KEY=$NEXT_PUBLIC_VAPID_PUBLIC_KEY
ENV NEXT_PUBLIC_GIPHY_API_KEY=$NEXT_PUBLIC_GIPHY_API_KEY
ENV MINIO_PUBLIC_URL=$MINIO_PUBLIC_URL
ENV NEXT_PUBLIC_DR_ENABLED=$NEXT_PUBLIC_DR_ENABLED

# NEXT_PUBLIC_API_URL is baked into the client bundle at build time. If it
# leaks through as empty the SPA silently points at the upstream default
# `https://api.onetothree.ru` and any non-default deployment is unreachable.
# Fail fast so the misconfig surfaces in CI/build logs rather than at runtime
# as "click login, nothing happens".
RUN test -n "${NEXT_PUBLIC_API_URL}" \
  || (echo "[build] FATAL: NEXT_PUBLIC_API_URL build-arg is empty. Set it in docker-compose args." && exit 1)

RUN printf '%s\n' \
  "NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}" \
  "NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}" \
  "NEXT_PUBLIC_WS_ORIGIN=${NEXT_PUBLIC_WS_ORIGIN}" \
  "NEXT_PUBLIC_VAPID_PUBLIC_KEY=${NEXT_PUBLIC_VAPID_PUBLIC_KEY}" \
  "NEXT_PUBLIC_GIPHY_API_KEY=${NEXT_PUBLIC_GIPHY_API_KEY}" \
  "NEXT_PUBLIC_DR_ENABLED=${NEXT_PUBLIC_DR_ENABLED}" \
  "NEXT_PUBLIC_APP_VERSION=${NEXT_PUBLIC_APP_VERSION}" \
  > .env.production

# Re-run the vendor-asset copy against the FULL context: the deps stage wrote
# public/ inside its own layer, which is not carried into this stage, and a
# fresh git clone has no public/mediapipe-wasm (gitignored).
RUN node scripts/copy-vendor-assets.js
RUN npm run build

# Standalone: `outputFileTracingRoot` is the client dir so `.next/standalone/server.js` lives here.
FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ARG API_INTERNAL_URL
ENV API_INTERNAL_URL=$API_INTERNAL_URL
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.env.production ./.env.production
COPY --from=builder /app/.env.production ./.env
RUN chown -R nextjs:nodejs /app
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
