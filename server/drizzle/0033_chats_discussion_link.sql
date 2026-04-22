-- Linked discussion group chat for Telegram-style channel comments.
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "discussion_chat_id" uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chats_discussion_chat_id_chats_id_fk'
  ) THEN
    ALTER TABLE "chats"
      ADD CONSTRAINT "chats_discussion_chat_id_chats_id_fk"
      FOREIGN KEY ("discussion_chat_id") REFERENCES "public"."chats"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "chats_discussion_chat_id_idx" ON "chats" ("discussion_chat_id");
