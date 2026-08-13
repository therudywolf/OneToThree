-- Multi-guest meeting links (docs/project/GUEST_MODE_CONCEPT.ru.md).
--
-- A guest link was strictly one-time: the first approved guest consumed it, so
-- a meeting could never have more than one guest, and the link vanished from
-- the creator's list the moment it was used. Capacity becomes explicit:
-- `max_uses` (1 = the old behaviour, used by temp-chat links) and a
-- `used_count` counter, so meeting links can admit several guests — each still
-- individually approved by the host.
--
-- `used_at` keeps its meaning ("exhausted"), now stamped when the LAST seat is
-- taken, so the sweeper's retention rules are unchanged.
-- Idempotent: safe to re-run.

ALTER TABLE "guest_invites" ADD COLUMN IF NOT EXISTS "max_uses" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "guest_invites" ADD COLUMN IF NOT EXISTS "used_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Rows consumed before this migration: one seat was taken.
UPDATE "guest_invites" SET "used_count" = 1
WHERE "used_at" IS NOT NULL AND "used_count" = 0;
