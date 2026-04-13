CREATE TABLE IF NOT EXISTS "message_reactions" (
  "message_id" uuid NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "emoji" varchar(32) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "message_reactions_pk" PRIMARY KEY("message_id","user_id","emoji")
);

CREATE INDEX IF NOT EXISTS "message_reactions_message_id_idx" ON "message_reactions" ("message_id");
