-- ============================================================
-- 0013: Optional linked discussion chat for channel comments.
-- Mirrors server/drizzle/0033_chats_discussion_link.sql
-- ============================================================

BEGIN;

ALTER TABLE chats ADD COLUMN IF NOT EXISTS discussion_chat_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chats_discussion_chat_id_chats_id_fk'
  ) THEN
    ALTER TABLE chats
      ADD CONSTRAINT chats_discussion_chat_id_chats_id_fk
      FOREIGN KEY (discussion_chat_id) REFERENCES chats (id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS chats_discussion_chat_id_idx ON chats (discussion_chat_id);

COMMIT;
