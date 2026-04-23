ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "invite_slug" text;
CREATE UNIQUE INDEX IF NOT EXISTS "chats_invite_slug_unique" ON "chats" USING btree ("invite_slug");
