-- ============================================================
-- 0011: Pinned messages support (1-to-1 chat `messages` table)
-- Adds `is_pinned` flag + `pinned_at` timestamp and an index
-- for the "pinned messages in this chat" header list.
--
-- Run: psql $DATABASE_URL -f this_file.sql
-- ============================================================

BEGIN;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_pinned boolean NOT NULL DEFAULT false;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS pinned_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS messages_chat_pinned_idx
  ON messages (chat_id, is_pinned);

COMMIT;
