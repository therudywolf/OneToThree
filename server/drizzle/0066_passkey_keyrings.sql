-- Passkey-sealed keyrings: the account key as an "electronic token" held by a
-- passkey (1Password, Bitwarden, iCloud Keychain, YubiKey). The keyring is
-- AES-GCM-sealed under an HKDF of the passkey's WebAuthn PRF output; the server
-- stores ciphertext + the public key it needs to verify an assertion before
-- releasing that ciphertext. See server/src/routes/passkey.ts.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS "passkey_keyrings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "credential_id" text NOT NULL,
  "public_key" text NOT NULL,
  "counter" bigint DEFAULT 0 NOT NULL,
  "transports" text,
  "aaguid" text,
  "label" text,
  "prf_salt" text NOT NULL,
  "hkdf_salt" text NOT NULL,
  "wrap_iv" text NOT NULL,
  "wrapped_keyring" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  CONSTRAINT "passkey_keyrings_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "passkey_keyrings"
    ADD CONSTRAINT "passkey_keyrings_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkey_keyrings_user_id_idx" ON "passkey_keyrings" ("user_id");
