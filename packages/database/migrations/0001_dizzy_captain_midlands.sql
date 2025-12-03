ALTER TABLE "billing_records" ALTER COLUMN "invoice_number" SET DEFAULT nextval('invoice_number_seq')::text;--> statement-breakpoint
ALTER TABLE "billing_records" ALTER COLUMN "invoice_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_records" ADD COLUMN "last_updated_at" timestamp;