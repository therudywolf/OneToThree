-- Integrity FKs for reply/device references (ON DELETE SET NULL: deleting a
-- parent message or device nulls the reference instead of leaving a dangling
-- pointer). Idempotent (DROP IF EXISTS + ADD) and orphan-safe (null out any
-- pre-existing dangling references first, or ADD CONSTRAINT would fail).
--
-- NOTE: the `user_group` type/column that `drizzle-kit generate` also emitted
-- here was intentionally removed — it is already applied by 0057 on every DB
-- (0057 was hand-written and did not refresh the snapshot). Re-applying it would
-- fail on prod / on a fresh migration replay.

UPDATE "messages" m SET "reply_to_id" = NULL
WHERE m."reply_to_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "messages" p WHERE p."id" = m."reply_to_id");
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_reply_to_id_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
UPDATE "group_messages" m SET "reply_to_id" = NULL
WHERE m."reply_to_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "group_messages" p WHERE p."id" = m."reply_to_id");
--> statement-breakpoint
ALTER TABLE "group_messages" DROP CONSTRAINT IF EXISTS "group_messages_reply_to_id_group_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_reply_to_id_group_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."group_messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
UPDATE "login_events" e SET "device_id" = NULL
WHERE e."device_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "devices" d WHERE d."id" = e."device_id");
--> statement-breakpoint
ALTER TABLE "login_events" DROP CONSTRAINT IF EXISTS "login_events_device_id_devices_id_fk";
--> statement-breakpoint
ALTER TABLE "login_events" ADD CONSTRAINT "login_events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;
