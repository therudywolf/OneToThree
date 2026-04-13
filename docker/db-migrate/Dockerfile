FROM node:20-alpine
WORKDIR /app
COPY docker/db-migrate/package.json ./
RUN npm install
COPY server/drizzle ./server/drizzle
COPY docker/db-migrate/migrate.mjs ./migrate.mjs
COPY docker/db-migrate/migrate.sh ./migrate.sh
RUN chmod +x ./migrate.sh
CMD ["sh", "./migrate.sh"]
