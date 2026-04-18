-- Stage 3 finalization: device-scoped delivery slots
-- Align legacy message_deliveries(message_id,user_id) with runtime contract
-- message_deliveries(message_id,device_id,user_id,ciphertext,iv,delivered_at).

ALTER TABLE "message_deliveries"
  ADD COLUMN IF NOT EXISTS "device_id" uuid,
  ADD COLUMN IF NOT EXISTS "ciphertext" text,
  ADD COLUMN IF NOT EXISTS "iv" text;

-- Backfill device_id for legacy rows: pick best active device per user.
UPDATE "message_deliveries" md
SET "device_id" = mapping."device_id"
FROM (
  SELECT
    md2."message_id",
    md2."user_id",
    d."id" AS "device_id"
  FROM "message_deliveries" md2
  JOIN LATERAL (
    SELECT "id"
    FROM "devices"
    WHERE "user_id" = md2."user_id" AND "revoked_at" IS NULL
    ORDER BY "is_master" DESC, "last_active" DESC, "created_at" ASC
    LIMIT 1
  ) d ON true
) mapping
WHERE md."device_id" IS NULL
  AND md."message_id" = mapping."message_id"
  AND md."user_id" = mapping."user_id";

-- Rows without any device cannot be used in device-scoped delivery; drop them.
DELETE FROM "message_deliveries" WHERE "device_id" IS NULL;

ALTER TABLE "message_deliveries"
  ALTER COLUMN "device_id" SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'message_deliveries'
      AND constraint_type = 'PRIMARY KEY'
      AND constraint_name = 'message_deliveries_message_id_user_id_pk'
  ) THEN
    ALTER TABLE "message_deliveries"
      DROP CONSTRAINT "message_deliveries_message_id_user_id_pk";
  END IF;
END $$;

ALTER TABLE "message_deliveries"
  DROP CONSTRAINT IF EXISTS "message_deliveries_message_id_device_id_pk";

ALTER TABLE "message_deliveries"
  ADD CONSTRAINT "message_deliveries_message_id_device_id_pk"
  PRIMARY KEY ("message_id", "device_id");

ALTER TABLE "message_deliveries"
  DROP CONSTRAINT IF EXISTS "message_deliveries_device_id_devices_id_fk";

ALTER TABLE "message_deliveries"
  ADD CONSTRAINT "message_deliveries_device_id_devices_id_fk"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "message_deliveries_device_id_idx"
  ON "message_deliveries" ("device_id");
