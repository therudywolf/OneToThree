import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
function requireDatabaseUrl() {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) {
        throw new Error('DATABASE_URL is not set');
    }
    return url;
}
const client = postgres(requireDatabaseUrl(), { max: 10 });
export const db = drizzle(client, { schema });
