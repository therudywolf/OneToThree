import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import fs from 'fs';

// Read DATABASE_URL: prefer env var, then Docker secrets
let url = process.env.DATABASE_URL;

if (!url) {
  const secretPaths = ['/run/secrets/db_url', '/run/secrets/database_url'];
  for (const p of secretPaths) {
    try {
      url = fs.readFileSync(p, 'utf8').trim();
      if (url) break;
    } catch { /* not found, try next */ }
  }
}

if (!url) {
  console.error('[migrate] ERROR: DATABASE_URL is not set and no Docker secret found');
  process.exit(1);
}

console.log('[migrate] Connecting to database...');
const client = new pg.Client({ connectionString: url });
await client.connect();
console.log('[migrate] Connected.');

const db = drizzle(client);

try {
  console.log('[migrate] Applying migrations from ./server/drizzle ...');
  await migrate(db, { migrationsFolder: './server/drizzle' });
  console.log('[migrate] All migrations applied successfully!');
} catch (err) {
  console.error('[migrate] Migration failed!');
  console.error(err);
  process.exit(1);
} finally {
  await client.end();
}
