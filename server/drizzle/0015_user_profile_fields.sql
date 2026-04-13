ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "bio" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "status_text" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "social_links" text;
