-- Phase 5.1 — broadcast-style channels.
-- Adds the `channel` variant to chat_type and a dedicated role enum
-- (subscriber / editor / owner) on chat_members.

ALTER TYPE "chat_type" ADD VALUE IF NOT EXISTS 'channel';
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "channel_role" AS ENUM ('subscriber', 'editor', 'owner');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

ALTER TABLE "chat_members"
  ADD COLUMN IF NOT EXISTS "channel_role" "channel_role";
--> statement-breakpoint

-- Keep data coherent: channel_role only exists for channel-typed chats.
ALTER TABLE "chat_members"
  DROP CONSTRAINT IF EXISTS "chat_members_channel_role_consistency";
--> statement-breakpoint

ALTER TABLE "chat_members"
  ADD CONSTRAINT "chat_members_channel_role_consistency"
  CHECK (
    ("channel_role" IS NULL)
    OR EXISTS (
      SELECT 1 FROM "chats" c
      WHERE c.id = "chat_members"."chat_id" AND c.type = 'channel'
    )
  ) NOT VALID;
--> statement-breakpoint

-- Index for channel discovery listings (public channels first, newest first).
CREATE INDEX IF NOT EXISTS "chats_channel_public_idx"
  ON "chats" ("type")
  WHERE "type" = 'channel';
