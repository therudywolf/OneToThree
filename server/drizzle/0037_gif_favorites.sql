CREATE TABLE IF NOT EXISTS "gif_favorites" (
  "user_id" uuid NOT NULL,
  "gif_id" text NOT NULL,
  "title" text NOT NULL,
  "preview_url" text NOT NULL,
  "original_url" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "gif_favorites_user_id_gif_id_pk" PRIMARY KEY ("user_id","gif_id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gif_favorites_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "gif_favorites"
      ADD CONSTRAINT "gif_favorites_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "gif_favorites_user_id_idx" ON "gif_favorites" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "gif_favorites_created_at_idx" ON "gif_favorites" USING btree ("created_at");
