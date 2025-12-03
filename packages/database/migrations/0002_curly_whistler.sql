CREATE TYPE "public"."billing_type" AS ENUM('immediate', 'scheduled');--> statement-breakpoint
ALTER TABLE "billing_records" ADD COLUMN "billing_type" "billing_type" DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_billing_type_status" ON "billing_records" USING btree ("billing_type","status") WHERE "billing_records"."status" = 'pending';