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
RUN chown -R app:app /app
USER app
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
