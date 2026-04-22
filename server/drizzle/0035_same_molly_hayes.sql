DO $$
BEGIN
  CREATE TYPE "public"."channel_role" AS ENUM ('subscriber', 'editor', 'owner');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$
BEGIN
  CREATE TYPE "public"."sticker_format" AS ENUM ('tgs', 'lottie', 'static', 'webm');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$
BEGIN
  ALTER TYPE "public"."chat_type" ADD VALUE 'channel';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sticker_packs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid,
  "title" varchar(128) NOT NULL,
  "short_name" varchar(64) NOT NULL,
  "format" "sticker_format" NOT NULL,
  "is_public" boolean DEFAULT false NOT NULL,
  "tg_source" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "stickers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pack_id" uuid NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "emoji" varchar(32) DEFAULT '' NOT NULL,
  "media_key" text NOT NULL,
  "thumbhash" text,
  "width" integer,
  "height" integer,
  "duration_ms" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "chat_members" ADD COLUMN IF NOT EXISTS "channel_role" "channel_role";--> statement-breakpoint
ALTER TABLE "chat_members" ADD COLUMN IF NOT EXISTS "muted_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "key_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "protocol_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "dr_header" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "dr_init" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "is_pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "pinned_at" timestamp with time zone;--> statement-breakpoint

DO $$
BEGIN
  ALTER TABLE "sticker_packs"
    ADD CONSTRAINT "sticker_packs_owner_id_users_id_fk"
    FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$
BEGIN
  ALTER TABLE "stickers"
    ADD CONSTRAINT "stickers_pack_id_sticker_packs_id_fk"
    FOREIGN KEY ("pack_id") REFERENCES "public"."sticker_packs"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "sticker_packs_short_name_unique" ON "sticker_packs" USING btree ("short_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sticker_packs_owner_idx" ON "sticker_packs" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stickers_pack_position_idx" ON "stickers" USING btree ("pack_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_members_user_idx" ON "chat_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_chat_id_seq_idx" ON "messages" USING btree ("chat_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_chat_pinned_idx" ON "messages" USING btree ("chat_id","is_pinned");