ALTER TABLE "users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_totp_enabled" boolean DEFAULT false NOT NULL;