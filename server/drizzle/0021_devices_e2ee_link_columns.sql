-- Stage 3: add E2EE linking metadata to devices
-- All columns are nullable/default-safe — no impact on existing rows.

ALTER TABLE "devices"
  ADD COLUMN IF NOT EXISTS "e2ee_public_key" text,
  ADD COLUMN IF NOT EXISTS "linked_at"       timestamptz,
  ADD COLUMN IF NOT EXISTS "label"           text,
  ADD COLUMN IF NOT EXISTS "migrated"        boolean NOT NULL DEFAULT false;
