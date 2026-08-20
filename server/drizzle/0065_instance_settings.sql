-- Runtime instance settings — operator knobs the admin panel can change without
-- an SSH session and a container restart.
--
-- Sparse by design: a row exists only for a knob an admin actually overrode.
-- The effective value is `override ?? env ?? built-in default`
-- (server/src/lib/instance-settings.ts), so an instance with an empty table
-- behaves exactly as it did when every knob was env-only.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS "instance_settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid
);
--> statement-breakpoint
-- SET NULL, like admin_audit_log: configuration must outlive the admin who set
-- it, or purging an operator would take the instance's settings with it.
DO $$ BEGIN
  ALTER TABLE "instance_settings"
    ADD CONSTRAINT "instance_settings_updated_by_users_id_fk"
    FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
