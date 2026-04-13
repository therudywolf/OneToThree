CREATE INDEX IF NOT EXISTS "messages_chat_id_created_at_idx" ON "messages" USING btree ("chat_id","created_at");
CREATE INDEX IF NOT EXISTS "messages_sender_id_idx" ON "messages" USING btree ("sender_id");
CREATE INDEX IF NOT EXISTS "messages_reply_to_id_idx" ON "messages" USING btree ("reply_to_id");

