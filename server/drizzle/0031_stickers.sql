-- Phase 5.2 — sticker packs + stickers.
-- TGS support (Telegram) relies on client-side Lottie player (dotlottie-web);
-- this migration only tracks metadata + MinIO object keys.

DO $$ BEGIN
  CREATE TYPE "sticker_format" AS ENUM ('tgs', 'lottie', 'static', 'webm');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sticker_packs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "title" varchar(128) NOT NULL,
  "short_name" varchar(64) NOT NULL,
  "format" "sticker_format" NOT NULL,
  "is_public" boolean NOT NULL DEFAULT false,
  "tg_source" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "sticker_packs_short_name_unique"
  ON "sticker_packs" ("short_name");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sticker_packs_owner_idx"
  ON "sticker_packs" ("owner_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "stickers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pack_id" uuid NOT NULL REFERENCES "sticker_packs"("id") ON DELETE CASCADE,
  "position" integer NOT NULL DEFAULT 0,
  "emoji" varchar(32) NOT NULL DEFAULT '',
  "media_key" text NOT NULL,
  "thumbhash" text,
  "width" integer,
  "height" integer,
  "duration_ms" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "stickers_pack_position_idx"
  ON "stickers" ("pack_id", "position");
