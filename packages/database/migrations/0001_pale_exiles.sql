CREATE TABLE "admin_notifications" (
	"notification_id" serial PRIMARY KEY NOT NULL,
	"severity" varchar(20) NOT NULL,
	"category" varchar(50) NOT NULL,
	"code" varchar(100) NOT NULL,
	"message" text NOT NULL,
	"details" text,
	"customer_id" varchar(50),
	"invoice_id" varchar(100),
	"acknowledged" boolean DEFAULT false NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_admin_notif_severity" ON "admin_notifications" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "idx_admin_notif_category" ON "admin_notifications" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_admin_notif_acknowledged" ON "admin_notifications" USING btree ("acknowledged") WHERE "admin_notifications"."acknowledged" = false;--> statement-breakpoint
CREATE INDEX "idx_admin_notif_created" ON "admin_notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_admin_notif_customer" ON "admin_notifications" USING btree ("customer_id") WHERE "admin_notifications"."customer_id" IS NOT NULL;