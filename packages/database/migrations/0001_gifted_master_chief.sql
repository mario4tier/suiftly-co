ALTER TYPE "public"."credit_reason" ADD VALUE 'refund';--> statement-breakpoint
ALTER TABLE "billing_records" ADD COLUMN "payment_action_url" varchar(500);