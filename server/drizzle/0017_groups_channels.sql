-- Group chats: groups, channels, group messages, threads

DO $$ BEGIN
  CREATE TYPE "group_type" AS ENUM ('group', 'channel', 'server');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "channel_type" AS ENUM ('text', 'voice', 'announcement');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(100) NOT NULL,
  "description" text,
  "avatar_url" text,
  "type" "group_type" NOT NULL DEFAULT 'group',
  "is_public" boolean NOT NULL DEFAULT false,
  "invite_code" varchar(64) UNIQUE,
  "owner_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "groups_owner_id_idx" ON "groups" ("owner_id");
CREATE UNIQUE INDEX IF NOT EXISTS "groups_invite_code_idx" ON "groups" ("invite_code");

CREATE TABLE IF NOT EXISTS "group_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_id" uuid NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" varchar(20) NOT NULL DEFAULT 'member',
  "nickname" varchar(50),
  "joined_at" timestamp with time zone NOT NULL DEFAULT now(),
  "muted_until" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "group_members_group_user_idx" ON "group_members" ("group_id", "user_id");
CREATE INDEX IF NOT EXISTS "group_members_user_id_idx" ON "group_members" ("user_id");

CREATE TABLE IF NOT EXISTS "channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_id" uuid NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
  "name" varchar(50) NOT NULL,
  "type" "channel_type" NOT NULL DEFAULT 'text',
  "topic" text,
  "position" integer NOT NULL DEFAULT 0,
  "is_nsfw" boolean NOT NULL DEFAULT false,
  "slow_mode" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "channels_group_id_idx" ON "channels" ("group_id");
CREATE INDEX IF NOT EXISTS "channels_group_position_idx" ON "channels" ("group_id", "position");

CREATE TABLE IF NOT EXISTS "group_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_id" uuid NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
  "channel_id" uuid REFERENCES "channels"("id") ON DELETE CASCADE,
  "sender_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "reply_to_id" uuid,
  "content" text,
  "is_pinned" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "group_messages_group_created_idx" ON "group_messages" ("group_id", "created_at");
CREATE INDEX IF NOT EXISTS "group_messages_channel_created_idx" ON "group_messages" ("channel_id", "created_at");
CREATE INDEX IF NOT EXISTS "group_messages_sender_idx" ON "group_messages" ("sender_id");

CREATE TABLE IF NOT EXISTS "message_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "channel_id" uuid REFERENCES "channels"("id") ON DELETE CASCADE,
  "group_id" uuid REFERENCES "groups"("id") ON DELETE CASCADE,
  "title" varchar(100),
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "message_threads_channel_idx" ON "message_threads" ("channel_id");
CREATE INDEX IF NOT EXISTS "message_threads_group_idx" ON "message_threads" ("group_id");
