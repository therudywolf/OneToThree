FROM node:20-alpine
WORKDIR /app
# Install from the committed lockfile. `npm install` re-resolved drizzle-orm, pg
# and their whole transitive tree from the live registry on every deploy, and a
# postinstall from any compromised patch release would have run as root inside
# the one container that migrate.sh then hands the production Postgres URL.
# `--ignore-scripts` because nothing here needs a build step (pg-native is
# optional and not installed).
COPY docker/db-migrate/package.json docker/db-migrate/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server/drizzle ./server/drizzle
COPY docker/db-migrate/migrate.mjs ./migrate.mjs
COPY docker/db-migrate/migrate.sh ./migrate.sh
RUN chmod +x ./migrate.sh
# The migrator only reads: the SQL folder, migrate.mjs and the mounted secret
# (compose leaves the host-side secret files 0644). Nothing needs root.
USER node
CMD ["sh", "./migrate.sh"]
