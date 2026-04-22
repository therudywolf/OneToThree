-- Phase 5.1 — broadcast-style channels (part 1 of 2).
--
-- Adds the `channel` variant to the existing chat_type enum in isolation.
-- PostgreSQL refuses to use a freshly added enum value inside the same
-- transaction in which it was declared (even with `NOT VALID` CHECKs), and
-- drizzle-orm wraps every migration file in BEGIN/COMMIT.  The enum value
-- therefore *must* land in its own file — continuation (channel role,
-- column, CHECK, index) lives in 0030_channels_members.sql.

ALTER TYPE "chat_type" ADD VALUE IF NOT EXISTS 'channel';
