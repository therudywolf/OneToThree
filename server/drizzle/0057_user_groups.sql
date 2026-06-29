-- User account groups / tiers, surfaced + managed in the admin panel.
-- `creator` is the immutable founder super-admin; `admin` grants the admin
-- panel. `role` is kept in sync with the group (creator/admin -> 'admin', else
-- 'user') so all existing role-based checks keep working unchanged.
-- Idempotent: safe to re-run.
DO $$ BEGIN
  CREATE TYPE "user_group" AS ENUM ('creator', 'admin', 'premium', 'regular', 'test');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "user_group" "user_group" NOT NULL DEFAULT 'regular';
--> statement-breakpoint
-- Backfill: existing admins -> admin group.
UPDATE "users" SET "user_group" = 'admin' WHERE "role" = 'admin';
--> statement-breakpoint
-- The founder (oldest account) -> creator (immutable super-admin).
UPDATE "users" SET "user_group" = 'creator'
WHERE "id" = (SELECT "id" FROM "users" ORDER BY "created_at" ASC NULLS LAST LIMIT 1);
--> statement-breakpoint
-- Keep role consistent with the group source-of-truth.
UPDATE "users" SET "role" = 'admin' WHERE "user_group" IN ('creator', 'admin') AND "role" <> 'admin';
--> statement-breakpoint
UPDATE "users" SET "role" = 'user' WHERE "user_group" IN ('premium', 'regular', 'test') AND "role" <> 'user';
