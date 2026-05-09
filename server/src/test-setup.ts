/**
 * Runs before any test file. Ensures env exists before modules that read DATABASE_URL/JWT at import time.
 */
import postgres from 'postgres'

process.env.JWT_SECRET =
  process.env.JWT_SECRET?.trim() ||
  'vitest-jwt-secret-must-be-32-chars-min!!'
{
  const base =
    process.env.DATABASE_URL?.trim() ||
    'postgres://forest:forest@127.0.0.1:5432/forest'
  const sep = base.includes('?') ? '&' : '?'
  // Fail fast when Postgres is down (e.g. Docker test without db service).
  process.env.DATABASE_URL = `${base}${sep}connect_timeout=2`
}
process.env.AUTH_CHALLENGE_RATE_LIMIT_MAX =
  process.env.AUTH_CHALLENGE_RATE_LIMIT_MAX?.trim() || '1000'
process.env.AUTH_CHALLENGE_RATE_LIMIT_WINDOW =
  process.env.AUTH_CHALLENGE_RATE_LIMIT_WINDOW?.trim() || '1 minute'

process.env.MINIO_ENDPOINT =
  process.env.MINIO_ENDPOINT?.trim() || 'http://127.0.0.1:9000'
process.env.MINIO_ROOT_USER = process.env.MINIO_ROOT_USER?.trim() || 'minio'
process.env.MINIO_ROOT_PASSWORD =
  process.env.MINIO_ROOT_PASSWORD?.trim() || 'minio_secret_change_me'
process.env.MINIO_BUCKET =
  process.env.MINIO_BUCKET?.trim() || 'project13-media'
process.env.MINIO_ACCESS_KEY =
  process.env.MINIO_ACCESS_KEY?.trim() || process.env.MINIO_ROOT_USER
process.env.MINIO_SECRET_KEY =
  process.env.MINIO_SECRET_KEY?.trim() || process.env.MINIO_ROOT_PASSWORD

/** QR link store tests use in-memory fallback unless `VITEST_REDIS_URL` is set. */
if (!process.env.VITEST_REDIS_URL) {
  delete process.env.REDIS_URL
}

// Some local dev databases may lag behind newest migrations; ensure required
// test-time compatibility for message ordering schema.
{
  const sql = postgres(process.env.DATABASE_URL as string, {
    max: 1,
    connect_timeout: 2,
  })
  try {
    async function hasColumn(table: string, column: string): Promise<boolean> {
      const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = ${table}
            AND column_name = ${column}
        ) AS exists
      `
      return rows[0]?.exists === true
    }

    async function hasTable(table: string): Promise<boolean> {
      const rows = await sql<{ exists: boolean }[]>`
        SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS exists
      `
      return rows[0]?.exists === true
    }

    async function hasIndex(index: string): Promise<boolean> {
      const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = ${index}
        ) AS exists
      `
      return rows[0]?.exists === true
    }

    await sql`SELECT pg_advisory_lock(hashtext('p13_test_setup_schema_compat'))`

    if (!await hasColumn('messages', 'seq')) {
      await sql`ALTER TABLE messages ADD COLUMN seq BIGSERIAL`
    }

    if (!await hasColumn('messages', 'sender_ecdh_public_key_jwk')) {
      await sql`ALTER TABLE messages ADD COLUMN sender_ecdh_public_key_jwk text`
    }

    if (!await hasColumn('messages', 'burn_duration_secs')) {
      await sql`ALTER TABLE messages ADD COLUMN burn_duration_secs integer`
    }

    if (!await hasColumn('messages', 'edited_at')) {
      await sql`ALTER TABLE messages ADD COLUMN edited_at timestamp with time zone`
    }

    if (!await hasColumn('chats', 'invite_slug')) {
      await sql`ALTER TABLE chats ADD COLUMN invite_slug text`
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS chats_invite_slug_unique ON chats (invite_slug)`
    }

    if (!await hasColumn('chats', 'invite_one_time')) {
      await sql`ALTER TABLE chats ADD COLUMN invite_one_time boolean NOT NULL DEFAULT false`
    }

    if (!await hasColumn('users', 'display_name')) {
      await sql`ALTER TABLE users ADD COLUMN display_name text`
    }

    if (!await hasColumn('users', 'last_seen_privacy')) {
      await sql`ALTER TABLE users ADD COLUMN last_seen_privacy text NOT NULL DEFAULT 'everyone'`
    }

    if (!await hasColumn('users', 'storage_quota_bytes')) {
      await sql`ALTER TABLE users ADD COLUMN storage_quota_bytes bigint`
    }

    if (!await hasTable('attachments')) {
      await sql`
        CREATE TABLE attachments (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE cascade,
          uploader_id uuid NOT NULL REFERENCES users(id) ON DELETE cascade,
          bucket text NOT NULL,
          object_key text NOT NULL,
          content_type text NOT NULL,
          size_bytes bigint NOT NULL,
          message_id uuid REFERENCES messages(id) ON DELETE set null,
          last_accessed_at timestamp with time zone DEFAULT now() NOT NULL,
          evicted_at timestamp with time zone,
          created_at timestamp with time zone DEFAULT now() NOT NULL
        )
      `
    }
    if (!await hasIndex('attachments_object_key_unique')) {
      await sql`CREATE UNIQUE INDEX attachments_object_key_unique ON attachments (object_key)`
    }
    if (!await hasIndex('attachments_last_accessed_idx')) {
      await sql`CREATE INDEX attachments_last_accessed_idx ON attachments (last_accessed_at)`
    }
    if (!await hasIndex('attachments_evicted_idx')) {
      await sql`CREATE INDEX attachments_evicted_idx ON attachments (evicted_at)`
    }
    if (!await hasIndex('attachments_message_id_idx')) {
      await sql`CREATE INDEX attachments_message_id_idx ON attachments (message_id)`
    }
    if (!await hasIndex('attachments_chat_id_idx')) {
      await sql`CREATE INDEX attachments_chat_id_idx ON attachments (chat_id)`
    }

    await sql`
      ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_last_seen_privacy_check
    `
    await sql`
      ALTER TABLE users
      ADD CONSTRAINT users_last_seen_privacy_check
      CHECK (last_seen_privacy IN ('everyone', 'contacts', 'nobody'))
    `
    await sql`SELECT pg_advisory_unlock(hashtext('p13_test_setup_schema_compat'))`
  } catch {
    // best-effort for environments without a running local DB
  } finally {
    await sql.end({ timeout: 1 })
  }
}
