-- Channel/group presentation + publicity.
--
-- Until now a chat had exactly one editable-at-creation field (`name`), which
-- made a channel unusable as a page: no description, no picture, and no way to
-- fix a typo in the title. Discovery also listed every `channel`/`public_open`
-- row unconditionally, so an owner had no way to keep a channel off the catalog
-- while still handing out its invite link.
--
-- `is_public` defaults to TRUE so every chat that is in the catalog today stays
-- there — the column only gives owners a switch they did not have.
-- `avatar_key` points into the avatars bucket under `avatars/{chatId}/…`, the
-- same layout (and the same AVATAR_KEY_RE) as user avatars.

ALTER TABLE "chats"
  ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint

ALTER TABLE "chats"
  ADD COLUMN IF NOT EXISTS "avatar_key" text;
--> statement-breakpoint

ALTER TABLE "chats"
  ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT true;
