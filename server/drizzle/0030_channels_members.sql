-- Phase 5.1 — broadcast-style channels (part 2 of 2).
--
-- Depends on 0029_channels.sql having committed the `channel` enum value.
-- Here we introduce the dedicated channel_role enum, the column on
-- chat_members, a trigger that ties the role to channel-typed chats, and the
-- discovery index.
--
-- NB: PostgreSQL forbids subqueries inside CHECK constraints (code 0A000,
-- "cannot use subquery in check constraint"), so the prior CHECK-based
-- enforcement was replaced with BEFORE INSERT/UPDATE triggers that perform
-- the exact same invariant but are allowed to reach into `chats`.

DO $$ BEGIN
  CREATE TYPE "channel_role" AS ENUM ('subscriber', 'editor', 'owner');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

ALTER TABLE "chat_members"
  ADD COLUMN IF NOT EXISTS "channel_role" "channel_role";
--> statement-breakpoint

-- Drop the legacy CHECK version if it was successfully installed on any
-- environment (idempotent — NOOP when missing).
ALTER TABLE "chat_members"
  DROP CONSTRAINT IF EXISTS "chat_members_channel_role_consistency";
--> statement-breakpoint

-- Enforce: channel_role is set <-> parent chat is of type 'channel'.
CREATE OR REPLACE FUNCTION "chat_members_channel_role_guard"() RETURNS trigger AS $$
DECLARE
  parent_type text;
BEGIN
  IF NEW."channel_role" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT c.type::text INTO parent_type FROM "chats" c WHERE c.id = NEW."chat_id";
  IF parent_type IS DISTINCT FROM 'channel' THEN
    RAISE EXCEPTION
      'chat_members.channel_role can only be set when the parent chat is of type ''channel'' (got %, parent=%)',
      parent_type, NEW."chat_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "chat_members_channel_role_guard_ins" ON "chat_members";
--> statement-breakpoint

CREATE TRIGGER "chat_members_channel_role_guard_ins"
  BEFORE INSERT OR UPDATE OF "channel_role", "chat_id" ON "chat_members"
  FOR EACH ROW
  EXECUTE FUNCTION "chat_members_channel_role_guard"();
--> statement-breakpoint

-- Index for channel discovery listings.
CREATE INDEX IF NOT EXISTS "chats_channel_public_idx"
  ON "chats" ("type")
  WHERE "type" = 'channel';
