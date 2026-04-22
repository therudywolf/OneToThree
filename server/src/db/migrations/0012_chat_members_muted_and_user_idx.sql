-- ============================================================
-- 0012: Per-chat mute + chat_members(user_id) index.
--
-- 1. `muted_until` column on chat_members: per-user mute timestamp.
--    NULL = not muted, non-NULL in future = muted until, past = expired.
-- 2. Supporting index on chat_members(user_id) so `loadUserChats`
--    (filter by user_id only) does not rely on the PK
--    (chat_id, user_id) for predicates on the trailing column.
--
-- Run: psql $DATABASE_URL -f this_file.sql
-- ============================================================

BEGIN;

ALTER TABLE chat_members
  ADD COLUMN IF NOT EXISTS muted_until timestamp with time zone;

CREATE INDEX IF NOT EXISTS chat_members_user_idx
  ON chat_members (user_id);

COMMIT;
