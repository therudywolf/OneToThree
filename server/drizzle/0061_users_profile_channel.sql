-- Personal channel pinned to the profile («стена», Telegram-style).
--
-- A single nullable pointer on `users`: a user may own many channels but pins
-- at most one to their profile. Ownership/type are enforced in the
-- PATCH /users/me handler; the DB guarantees only referential integrity and
-- auto-unlink when the channel is deleted (ON DELETE SET NULL).

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "profile_channel_id" uuid
  REFERENCES "chats"("id") ON DELETE SET NULL;
