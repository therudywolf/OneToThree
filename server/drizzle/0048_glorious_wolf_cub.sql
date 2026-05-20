-- Performance indexes (track C). The drizzle snapshot chain for 0046/0047
-- had drifted, so `drizzle-kit generate` emitted spurious CREATE TABLE /
-- ADD COLUMN statements for already-existing objects. This file is the
-- hand-corrected migration: only the four new indexes, each idempotent.
CREATE INDEX IF NOT EXISTS "attachments_uploader_id_idx" ON "attachments" USING btree ("uploader_id") WHERE "attachments"."evicted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_lru_idx" ON "attachments" USING btree ("message_id","last_accessed_at") WHERE "attachments"."evicted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_chat_unread_idx" ON "messages" USING btree ("chat_id","sender_id") WHERE "messages"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_media_path_idx" ON "messages" USING btree ("created_at") WHERE "messages"."media_path" IS NOT NULL;
