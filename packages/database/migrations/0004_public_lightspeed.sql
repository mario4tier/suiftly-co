ALTER TYPE "public"."service_type" ADD VALUE 'ssfn';--> statement-breakpoint
ALTER TYPE "public"."service_type" ADD VALUE 'sealo';--> statement-breakpoint
ALTER TABLE "service_instances" DROP COLUMN "last_billed_timestamp";