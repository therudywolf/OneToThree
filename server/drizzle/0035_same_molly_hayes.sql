CREATE TYPE "public"."channel_role" AS ENUM('subscriber', 'editor', 'owner');--> statement-breakpoint
CREATE TYPE "public"."sticker_format" AS ENUM('tgs', 'lottie', 'static', 'webm');--> statement-breakpoint
ALTER TYPE "public"."chat_type" ADD VALUE 'channel';--> statement-breakpoint
CREATE TABLE "sticker_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"title" varchar(128) NOT NULL,
	"short_name" varchar(64) NOT NULL,
	"format" "sticker_format" NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"tg_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stickers" (
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
);
--> statement-breakpoint
ALTER TABLE "chat_members" ADD COLUMN "channel_role" "channel_role";--> statement-breakpoint
ALTER TABLE "chat_members" ADD COLUMN "muted_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "key_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "protocol_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "dr_header" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "dr_init" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "is_pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sticker_packs" ADD CONSTRAINT "sticker_packs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stickers" ADD CONSTRAINT "stickers_pack_id_sticker_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."sticker_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sticker_packs_short_name_unique" ON "sticker_packs" USING btree ("short_name");--> statement-breakpoint
CREATE INDEX "sticker_packs_owner_idx" ON "sticker_packs" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "stickers_pack_position_idx" ON "stickers" USING btree ("pack_id","position");--> statement-breakpoint
CREATE INDEX "chat_members_user_idx" ON "chat_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "messages_chat_id_seq_idx" ON "messages" USING btree ("chat_id","seq");--> statement-breakpoint
CREATE INDEX "messages_chat_pinned_idx" ON "messages" USING btree ("chat_id","is_pinned");