-- Group E2EE key rotation signal (bump when membership forfeits decrypt for future messages).
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "key_epoch" integer NOT NULL DEFAULT 0;
