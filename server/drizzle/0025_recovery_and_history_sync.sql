ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "recovery_key_salt" text,
  ADD COLUMN IF NOT EXISTS "recovery_key_hash" text,
  ADD COLUMN IF NOT EXISTS "recovery_key_set_at" timestamp with time zone;

ALTER TABLE "devices"
  ADD COLUMN IF NOT EXISTS "history_sync_enabled_at" timestamp with time zone;
