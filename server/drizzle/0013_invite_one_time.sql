ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "invite_one_time" boolean DEFAULT false NOT NULL;
