-- Stage 5 compatibility: drizzle schema expects per-device ECDH key column.
-- Older databases created before this change miss the column and fail device upserts.
ALTER TABLE "devices"
  ADD COLUMN IF NOT EXISTS "ecdh_public_key" text;
