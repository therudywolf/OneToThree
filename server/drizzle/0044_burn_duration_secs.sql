-- Migration: add burn_duration_secs to messages
-- When set, server computes burn_at = read_at + burn_duration_secs at read time.
-- Supersedes client-computed burn_at so the timer starts from READ, not send.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "burn_duration_secs" integer;
