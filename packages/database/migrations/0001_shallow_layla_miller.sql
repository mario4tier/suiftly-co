ALTER TABLE "customers" DROP CONSTRAINT "check_customer_id";--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "check_customer_id" CHECK ("customers"."customer_id" != 0);