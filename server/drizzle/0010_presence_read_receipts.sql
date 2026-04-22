ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "read_at" timestamp with time zone;
