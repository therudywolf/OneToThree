-- Migration 0014: add edited_at column to messages
-- Allows tracking when a message was last edited by the sender.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "edited_at" timestamp with time zone;
