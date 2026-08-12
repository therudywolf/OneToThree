-- Guest mode (docs/project/GUEST_MODE_CONCEPT.ru.md).
--
-- Mechanism A (call guest) is "bodiless" — it needs only the invite-link table
-- and a jsonb trace on call_sessions. Mechanism B (temp chat guest) adds the
-- first account-lifecycle columns to `users` and the 'guest' tier.
-- Idempotent: safe to re-run.

-- The new value is only DEFINED here, never USED in this migration, so the
-- add-in-transaction restriction does not apply.
ALTER TYPE "user_group" ADD VALUE IF NOT EXISTS 'guest';
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "guest_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "guest_invited_by" uuid
  REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- The only trace a call guest leaves: [{ nick, joined_at, left_at?, kicked? }]
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "guests" jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "guest_invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token" text NOT NULL,
  "purpose" text NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "chat_id" uuid REFERENCES "chats"("id") ON DELETE CASCADE,
  "room_id" uuid,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "can_publish" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "guest_invites_token_unique" ON "guest_invites" ("token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guest_invites_created_by_idx" ON "guest_invites" ("created_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guest_invites_chat_id_idx" ON "guest_invites" ("chat_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guest_invites_expires_at_idx" ON "guest_invites" ("expires_at");
