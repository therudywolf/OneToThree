CREATE TABLE IF NOT EXISTS "chat_favorites" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "chat_id" uuid NOT NULL REFERENCES "chats"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chat_favorites_user_id_chat_id_pk" PRIMARY KEY ("user_id","chat_id")
);

CREATE INDEX IF NOT EXISTS "chat_favorites_user_id_idx"
  ON "chat_favorites" ("user_id");

CREATE INDEX IF NOT EXISTS "chat_favorites_chat_id_idx"
  ON "chat_favorites" ("chat_id");
