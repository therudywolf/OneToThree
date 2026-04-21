-- Add is_pinned + pinned_at to messages, muted_until to chat_members.
-- These columns were added to schema.ts but never included in the drizzle
-- migration set (only existed in server/src/db/migrations/ manual SQL files).
-- Using IF NOT EXISTS so this is safe to run on databases that already have
-- these columns (e.g. local dev with db:push applied).

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "is_pinned" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_members" ADD COLUMN IF NOT EXISTS "muted_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_chat_pinned_idx" ON "messages" ("chat_id","is_pinned");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_members_user_idx" ON "chat_members" ("user_id");
