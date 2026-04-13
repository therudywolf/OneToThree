-- Security audit: login events and user blocks

DO $$ BEGIN
  CREATE TYPE "login_event_outcome" AS ENUM ('success', 'fail_signature', 'fail_totp', 'fail_banned', 'fail_device_revoked');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "login_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "username" text NOT NULL,
  "outcome" "login_event_outcome" NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "device_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "login_events_user_id_idx" ON "login_events" ("user_id");
CREATE INDEX IF NOT EXISTS "login_events_created_at_idx" ON "login_events" ("created_at");

CREATE TABLE IF NOT EXISTS "user_blocks" (
  "blocker_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "blocked_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("blocker_id", "blocked_id")
);

CREATE INDEX IF NOT EXISTS "user_blocks_blocker_id_idx" ON "user_blocks" ("blocker_id");
CREATE INDEX IF NOT EXISTS "user_blocks_blocked_id_idx" ON "user_blocks" ("blocked_id");
