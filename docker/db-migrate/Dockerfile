FROM node:20-alpine
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY docker/db-migrate/package.json docker/db-migrate/package-lock.json ./
RUN npm ci
COPY drizzle.config.ts ./
COPY server/src/db/schema.ts ./server/src/db/schema.ts
COPY server/drizzle ./server/drizzle
# migrate применяет только новые SQL файлы из server/drizzle/ — безопасно при апдейтах
CMD ["node", "./node_modules/drizzle-kit/bin.cjs", "migrate", "--config", "drizzle.config.ts"]
