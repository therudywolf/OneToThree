CREATE TABLE IF NOT EXISTS "message_deliveries" (
	"message_id" uuid NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "message_deliveries_message_id_user_id_pk" PRIMARY KEY ("message_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_deliveries_user_pending_idx" ON "message_deliveries" ("user_id", "delivered_at");
--> statement-breakpoint
INSERT INTO "message_deliveries" ("message_id", "user_id", "delivered_at")
SELECT m."id", cm."user_id", now()
FROM "messages" m
JOIN "chat_members" cm ON cm."chat_id" = m."chat_id" AND cm."user_id" <> m."sender_id"
ON CONFLICT ("message_id", "user_id") DO NOTHING;
