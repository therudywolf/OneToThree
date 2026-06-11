ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "recovery_vault_blob" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "recovery_auth_pub_jwk" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "recovery_require_totp" boolean DEFAULT false NOT NULL;
