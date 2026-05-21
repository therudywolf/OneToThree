-- Track A4 stage 1 — device-scoped X3DH key directory.
-- identity_keys / signed_prekeys / onetime_prekeys move from per-user to
-- per-(user, device). Production has no real key material, so the tables are
-- dropped and recreated rather than ALTER-ed (a primary-key change cannot be
-- done in place). Idempotent: IF EXISTS / IF NOT EXISTS throughout.
DROP TABLE IF EXISTS "onetime_prekeys" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "signed_prekeys" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "identity_keys" CASCADE;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identity_keys" (
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"signing_public_key" text NOT NULL,
	"exchange_public_key" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_keys_user_id_device_id_pk" PRIMARY KEY("user_id","device_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signed_prekeys" (
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"pre_key_id" integer NOT NULL,
	"public_key" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signed_prekeys_user_id_device_id_pre_key_id_pk" PRIMARY KEY("user_id","device_id","pre_key_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onetime_prekeys" (
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"pre_key_id" integer NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onetime_prekeys_user_id_device_id_pre_key_id_pk" PRIMARY KEY("user_id","device_id","pre_key_id")
);--> statement-breakpoint
ALTER TABLE "identity_keys" ADD CONSTRAINT "identity_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_keys" ADD CONSTRAINT "identity_keys_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_prekeys" ADD CONSTRAINT "signed_prekeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_prekeys" ADD CONSTRAINT "signed_prekeys_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onetime_prekeys" ADD CONSTRAINT "onetime_prekeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onetime_prekeys" ADD CONSTRAINT "onetime_prekeys_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signed_prekeys_user_created_idx" ON "signed_prekeys" USING btree ("user_id","device_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onetime_prekeys_user_idx" ON "onetime_prekeys" USING btree ("user_id","device_id");
