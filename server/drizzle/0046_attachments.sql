CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"message_id" uuid,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evicted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_object_key_unique" ON "attachments" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "attachments_last_accessed_idx" ON "attachments" USING btree ("last_accessed_at");--> statement-breakpoint
CREATE INDEX "attachments_evicted_idx" ON "attachments" USING btree ("evicted_at");--> statement-breakpoint
CREATE INDEX "attachments_message_id_idx" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "attachments_chat_id_idx" ON "attachments" USING btree ("chat_id");
