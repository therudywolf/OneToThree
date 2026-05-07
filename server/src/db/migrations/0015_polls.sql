-- polls: Telegram-style polls attached to chat messages
CREATE TABLE IF NOT EXISTS "polls" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "chat_id"        uuid NOT NULL REFERENCES "chats"("id") ON DELETE CASCADE,
  "message_id"     uuid REFERENCES "messages"("id") ON DELETE CASCADE,
  "created_by"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "question"       varchar(300) NOT NULL,
  "options"        jsonb NOT NULL,
  "allow_multiple" boolean NOT NULL DEFAULT false,
  "is_anonymous"   boolean NOT NULL DEFAULT false,
  "closed_at"      timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "polls_chat_idx"    ON "polls"("chat_id");
CREATE INDEX IF NOT EXISTS "polls_message_idx" ON "polls"("message_id");

-- poll_votes: one row per (poll, user, option) tuple
CREATE TABLE IF NOT EXISTS "poll_votes" (
  "poll_id"      uuid NOT NULL REFERENCES "polls"("id") ON DELETE CASCADE,
  "user_id"      uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "option_index" integer NOT NULL,
  "voted_at"     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("poll_id", "user_id", "option_index")
);

CREATE INDEX IF NOT EXISTS "poll_votes_poll_idx" ON "poll_votes"("poll_id");
