#!/bin/sh
set -e
echo "[db-migrate] Running drizzle-kit migrate..."
node ./node_modules/drizzle-kit/bin.cjs migrate --config drizzle.config.ts
echo "[db-migrate] Done."
exit 0
