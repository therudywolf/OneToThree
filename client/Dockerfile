# Production: multi-stage build (deps → build → minimal runner)
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
# Prefer deterministic `npm ci`, but if package-lock is out-of-sync with
# package.json (common after dependabot PRs or new feature deps that weren't
# pre-locked), self-heal by rebuilding the lockfile and retrying.  This keeps
# `./start.sh update` idempotent across arbitrary dependency changes.
RUN npm ci --no-audit --no-fund \
  || (echo '[deps] lockfile drift detected, regenerating...' \
      && npm install --package-lock-only --no-audit --no-fund \
      && npm ci --no-audit --no-fund)

FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time public env (baked into client bundle; set via docker-compose `args:`)
ARG API_INTERNAL_URL
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_ORIGIN
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
ARG MINIO_PUBLIC_URL
ENV API_INTERNAL_URL=$API_INTERNAL_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WS_ORIGIN=$NEXT_PUBLIC_WS_ORIGIN
ENV NEXT_PUBLIC_VAPID_PUBLIC_KEY=$NEXT_PUBLIC_VAPID_PUBLIC_KEY
ENV MINIO_PUBLIC_URL=$MINIO_PUBLIC_URL

RUN printf '%s\n' \
  "NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}" \
  "NEXT_PUBLIC_WS_ORIGIN=${NEXT_PUBLIC_WS_ORIGIN}" \
  "NEXT_PUBLIC_VAPID_PUBLIC_KEY=${NEXT_PUBLIC_VAPID_PUBLIC_KEY}" \
  > .env.production

RUN npm run build

# Standalone: `outputFileTracingRoot` is the client dir so `.next/standalone/server.js` lives here.
FROM node:20-alpine AS runner
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
