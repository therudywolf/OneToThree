CREATE TABLE IF NOT EXISTS "sticker_pack_shares" (
  "pack_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sticker_pack_shares_pack_id_user_id_pk" PRIMARY KEY ("pack_id","user_id")
);

DO $$ BEGIN
  ALTER TABLE "sticker_pack_shares"
    ADD CONSTRAINT "sticker_pack_shares_pack_id_sticker_packs_id_fk"
    FOREIGN KEY ("pack_id")
    REFERENCES "public"."sticker_packs"("id")
    ON DELETE cascade
    ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "sticker_pack_shares"
    ADD CONSTRAINT "sticker_pack_shares_user_id_users_id_fk"
    FOREIGN KEY ("user_id")
    REFERENCES "public"."users"("id")
    ON DELETE cascade
    ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "sticker_pack_shares_user_idx"
  ON "sticker_pack_shares" USING btree ("user_id");

UPDATE "sticker_packs"
SET "is_public" = false
WHERE "tg_source" IS NOT NULL;
