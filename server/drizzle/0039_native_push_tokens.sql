DO $$
BEGIN
  CREATE TYPE "native_push_platform" AS ENUM ('android');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "native_push_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "platform" "native_push_platform" NOT NULL,
  "token" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "native_push_tokens_user_platform_token_idx"
  ON "native_push_tokens" USING btree ("user_id", "platform", "token");

CREATE INDEX IF NOT EXISTS "native_push_tokens_user_idx"
  ON "native_push_tokens" USING btree ("user_id");
