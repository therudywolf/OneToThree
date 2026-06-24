ALTER TABLE "admin_audit_log" DROP CONSTRAINT "admin_audit_log_admin_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ALTER COLUMN "admin_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;