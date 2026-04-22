CREATE INDEX IF NOT EXISTS messages_chat_media_idx ON messages(chat_id) WHERE media_path IS NOT NULL;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS users_username_trgm_idx ON users USING gin(username gin_trgm_ops);
