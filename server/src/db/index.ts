import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'
import { readSecret } from '../lib/read-secret.js'

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    throw new Error('DATABASE_URL is not set')
  }
  // If POSTGRES_PASSWORD_FILE is available, replace the password in the URL
  const secretPassword = readSecret('POSTGRES_PASSWORD')
  if (secretPassword && process.env.POSTGRES_PASSWORD_FILE) {
    try {
      const parsed = new URL(url)
      parsed.password = secretPassword
      return parsed.toString()
    } catch {
      // URL parsing failed, return as-is
    }
  }
  return url
}

const client = postgres(requireDatabaseUrl(), { max: 10 })

export const db = drizzle(client, { schema })

export type Db = typeof db
