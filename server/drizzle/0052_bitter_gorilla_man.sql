ALTER TABLE "users" DROP COLUMN IF EXISTS "recovery_key_salt";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "recovery_key_hash";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "recovery_key_set_at";
