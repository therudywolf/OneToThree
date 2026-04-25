ALTER TABLE users
  ADD COLUMN IF NOT EXISTS display_name text;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_seen_privacy text NOT NULL DEFAULT 'everyone';

UPDATE users
SET last_seen_privacy = 'everyone'
WHERE last_seen_privacy IS NULL;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_last_seen_privacy_check;

ALTER TABLE users
  ADD CONSTRAINT users_last_seen_privacy_check
  CHECK (last_seen_privacy IN ('everyone', 'contacts', 'nobody'));
