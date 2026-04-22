-- Phase 3.3 — message protocol versioning + Double Ratchet header channel.
-- Messages default to v1 (legacy). Clients lift to v2 after X3DH completes.

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "protocol_version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "dr_header" text;
