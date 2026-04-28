DO $$ BEGIN
  CREATE TYPE "public"."native_push_platform" AS ENUM('android');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE "gif_favorites" (
	"user_id" uuid NOT NULL,
	"gif_id" text NOT NULL,
	"title" text NOT NULL,
	"preview_url" text NOT NULL,
	"original_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gif_favorites_user_id_gif_id_pk" PRIMARY KEY("user_id","gif_id")
);
--> statement-breakpoint
CREATE TABLE "native_push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" "native_push_platform" NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sticker_pack_shares" (
	"pack_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sticker_pack_shares_pack_id_user_id_pk" PRIMARY KEY("pack_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "allow_device_linking" SET DEFAULT true;--> statement-breakpoint
UPDATE "users" SET "allow_device_linking" = true WHERE "allow_device_linking" = false;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "invite_slug" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_privacy" text DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "gif_favorites" ADD CONSTRAINT "gif_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_push_tokens" ADD CONSTRAINT "native_push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sticker_pack_shares" ADD CONSTRAINT "sticker_pack_shares_pack_id_sticker_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."sticker_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sticker_pack_shares" ADD CONSTRAINT "sticker_pack_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gif_favorites_user_id_idx" ON "gif_favorites" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "gif_favorites_created_at_idx" ON "gif_favorites" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "native_push_tokens_user_platform_token_idx" ON "native_push_tokens" USING btree ("user_id","platform","token");--> statement-breakpoint
CREATE INDEX "native_push_tokens_user_idx" ON "native_push_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sticker_pack_shares_user_idx" ON "sticker_pack_shares" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chats_invite_slug_unique" ON "chats" USING btree ("invite_slug");