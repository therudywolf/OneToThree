-- Reconcile the drizzle model/snapshot with the live production DB.
--
-- All three objects below ALREADY EXIST in prod, so this migration is written
-- defensively (IF EXISTS / IF NOT EXISTS / pg_constraint guards) and is safe to
-- replay against a DB that already matches:
--   * groups.owner_id and message_threads.created_by FKs were created INLINE and
--     UNNAMED by migration 0017, so Postgres auto-named them "*_fkey". They are
--     already ON DELETE SET NULL in the DB but the drizzle model recorded them
--     as "no action". Drop the auto-named (or already-drizzle-named) constraint
--     and (re)add it under the drizzle-convention name with ON DELETE SET NULL.
--   * chats.discussion_chat_id column + FK + index were created by 0033. They are
--     declared in the model now only so a future generate/push does not drift —
--     the statements here are no-ops on a DB that already has them.
--
-- The drizzle-generated SQL used a bare `DROP CONSTRAINT "<drizzle_name>"` (a
-- name that does NOT exist in prod for the 0017 inline FKs) and `ADD COLUMN`
-- without IF NOT EXISTS, both of which would ABORT the prod migrate. This
-- hand-edited version cannot.

-- groups.owner_id -> ON DELETE SET NULL, drizzle-convention constraint name
ALTER TABLE "groups" DROP CONSTRAINT IF EXISTS "groups_owner_id_fkey";
ALTER TABLE "groups" DROP CONSTRAINT IF EXISTS "groups_owner_id_users_id_fk";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'groups_owner_id_users_id_fk') THEN
    ALTER TABLE "groups" ADD CONSTRAINT "groups_owner_id_users_id_fk"
      FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint

-- message_threads.created_by -> ON DELETE SET NULL, drizzle-convention name
ALTER TABLE "message_threads" DROP CONSTRAINT IF EXISTS "message_threads_created_by_fkey";
ALTER TABLE "message_threads" DROP CONSTRAINT IF EXISTS "message_threads_created_by_users_id_fk";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_threads_created_by_users_id_fk') THEN
    ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_created_by_users_id_fk"
      FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint

-- chats.discussion_chat_id — already created by 0033; assert idempotently.
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "discussion_chat_id" uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chats_discussion_chat_id_chats_id_fk') THEN
    ALTER TABLE "chats" ADD CONSTRAINT "chats_discussion_chat_id_chats_id_fk"
      FOREIGN KEY ("discussion_chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chats_discussion_chat_id_idx" ON "chats" USING btree ("discussion_chat_id");
