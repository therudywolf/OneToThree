ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hide_presence" boolean DEFAULT false NOT NULL;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "media_original_bytes" bigint;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "burn_at" timestamp with time zone;
