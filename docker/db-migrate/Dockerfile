FROM node:20-alpine
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY docker/db-migrate/package.json docker/db-migrate/package-lock.json ./
RUN npm ci
COPY drizzle.config.ts ./
COPY server/src/db/schema.ts ./server/src/db/schema.ts
ENV DATABASE_URL=postgres://forest:forest@db:5432/forest
CMD ["node", "./node_modules/drizzle-kit/bin.cjs", "push", "--config", "drizzle.config.ts"]
