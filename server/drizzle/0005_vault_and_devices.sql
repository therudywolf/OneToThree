ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "vault_blob" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "vault_version" integer DEFAULT 0 NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "vault_updated_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"client_device_key" text NOT NULL,
	"device_name" text NOT NULL,
	"last_active" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "devices_user_client_key_idx" ON "devices" ("user_id", "client_device_key");
CREATE INDEX IF NOT EXISTS "devices_user_id_idx" ON "devices" ("user_id");
