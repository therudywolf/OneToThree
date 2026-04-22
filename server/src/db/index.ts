import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'
import { readSecret } from '../lib/read-secret.js'

function buildDatabaseUrl(): string {
  // Always build URL from components so the password is properly URL-encoded
  // regardless of what DATABASE_URL env var contains.
  const password = readSecret('POSTGRES_PASSWORD')
  if (password) {
    const user = (process.env.POSTGRES_USER ?? 'forest').trim()
    const db   = (process.env.POSTGRES_DB   ?? 'forest').trim()
    const host = 'db'
    const port = '5432'
    // URL constructor handles encoding of special chars (/, +, =, etc.)
    const url = new URL(`postgres://${host}`)
    url.username = user
    url.password = password
    url.hostname = host
    url.port     = port
    url.pathname = `/${db}`
    return url.toString()
  }

  // Fallback: use DATABASE_URL as-is (dev / non-Docker environments)
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    throw new Error('DATABASE_URL is not set and POSTGRES_PASSWORD is unavailable')
  }
  return url
}

const client = postgres(buildDatabaseUrl(), { max: 10 })

export const db = drizzle(client, { schema })

export type Db = typeof db
