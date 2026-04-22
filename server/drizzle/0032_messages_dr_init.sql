-- Phase 6.1 — Double Ratchet runtime activation.
--
-- Adds the `dr_init` column to `messages`, which carries the X3DH handshake
-- metadata the responder needs on the very first v2 message of a session.
-- Subsequent v2 messages only carry `dr_header`; v1 messages carry neither.
--
-- Payload shape (text, JSON-encoded, base64url-encoded inner fields):
--   {
--     "initiatorIdentityExchange": "...",
--     "initiatorIdentitySigning":  "...",
--     "initiatorEphemeralPublic":  "...",
--     "signedPrekeyId":            <int>,
--     "oneTimePrekeyId":           <int|null>
--   }
--
-- The column is nullable and indexed with a partial predicate so we can scan
-- for unacked handshakes quickly (pending-init recovery after reinstall).

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "dr_init" text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "messages_pending_dr_init_idx"
  ON "messages" ("chat_id", "created_at")
  WHERE "dr_init" IS NOT NULL;
