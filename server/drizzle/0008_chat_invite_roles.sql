DO $$ BEGIN
 CREATE TYPE "chat_member_role" AS ENUM ('owner', 'admin', 'member');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "chat_members" ADD COLUMN IF NOT EXISTS "role" "chat_member_role" DEFAULT 'member' NOT NULL;

UPDATE "chat_members" cm
SET "role" = 'owner'
FROM (
  SELECT DISTINCT ON ("chat_id") "chat_id", "user_id"
  FROM "chat_members"
  INNER JOIN "chats" ON "chats"."id" = "chat_members"."chat_id"
  WHERE "chats"."type" = 'group_e2e'
  ORDER BY "chat_id", "joined_at" ASC, "user_id" ASC
) AS first_member
WHERE cm."chat_id" = first_member."chat_id"
  AND cm."user_id" = first_member."user_id";

ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "invite_code" text;

CREATE UNIQUE INDEX IF NOT EXISTS "chats_invite_code_unique" ON "chats" ("invite_code");
