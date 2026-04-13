FROM node:20-alpine
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY docker/db-migrate/package.json docker/db-migrate/package-lock.json ./
RUN npm ci
COPY drizzle.config.ts ./
COPY server/src/db/schema.ts ./server/src/db/schema.ts
COPY server/drizzle ./server/drizzle
# migrate применяет только новые SQL файлы из server/drizzle/ — безопасно при апдейтах
COPY docker/db-migrate/migrate.sh ./migrate.sh
RUN chmod +x ./migrate.sh
CMD ["sh", "./migrate.sh"]
