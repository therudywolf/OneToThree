-- D4: bind each device's X3DH identityExchange key to its Ed25519 identity
-- signing key (new column `exchange_public_key_signature`). Clients now reject a
-- bundle whose exchange key isn't signed, closing a server-side MITM on X3DH.
--
-- Prod holds only throwaway test accounts (no real users / clients), so instead
-- of a backward-compat window we simply CLEAR the X3DH key directory: every
-- device re-publishes a freshly SIGNED identity + prekeys on its next vault
-- unlock. This lets us add the column NOT NULL with no legacy unsigned rows.
-- (Double Ratchet session state is client-side; peers re-handshake transparently.)
DELETE FROM "onetime_prekeys";--> statement-breakpoint
DELETE FROM "signed_prekeys";--> statement-breakpoint
DELETE FROM "identity_keys";--> statement-breakpoint
ALTER TABLE "identity_keys" ADD COLUMN "exchange_public_key_signature" text NOT NULL;
