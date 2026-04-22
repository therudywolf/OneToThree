-- Phase 3.2 — Double Ratchet / X3DH key directory.
-- Adds identity_keys, signed_prekeys, onetime_prekeys.
-- These tables are additive; no existing data is modified.

CREATE TABLE IF NOT EXISTS "identity_keys" (
  "user_id" uuid NOT NULL,
  "signing_public_key" text NOT NULL,
  "exchange_public_key" text NOT NULL,
  "generation" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "identity_keys_user_id_pk" PRIMARY KEY ("user_id"),
  CONSTRAINT "identity_keys_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "signed_prekeys" (
  "user_id" uuid NOT NULL,
  "pre_key_id" integer NOT NULL,
  "public_key" text NOT NULL,
  "signature" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "signed_prekeys_user_id_pre_key_id_pk" PRIMARY KEY ("user_id","pre_key_id"),
  CONSTRAINT "signed_prekeys_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "onetime_prekeys" (
  "user_id" uuid NOT NULL,
  "pre_key_id" integer NOT NULL,
  "public_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onetime_prekeys_user_id_pre_key_id_pk" PRIMARY KEY ("user_id","pre_key_id"),
  CONSTRAINT "onetime_prekeys_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "signed_prekeys_user_created_idx"
  ON "signed_prekeys" USING btree ("user_id", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "onetime_prekeys_user_idx"
  ON "onetime_prekeys" USING btree ("user_id");
