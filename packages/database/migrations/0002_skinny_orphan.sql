-- Create ENUM types
CREATE TYPE "public"."billing_status" AS ENUM('pending', 'paid', 'failed');--> statement-breakpoint
CREATE TYPE "public"."customer_status" AS ENUM('active', 'suspended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."service_state" AS ENUM('not_provisioned', 'provisioning', 'disabled', 'enabled', 'suspended_maintenance', 'suspended_no_payment');--> statement-breakpoint
CREATE TYPE "public"."service_tier" AS ENUM('starter', 'pro', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."service_type" AS ENUM('seal', 'grpc', 'graphql');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('deposit', 'withdraw', 'charge', 'credit');--> statement-breakpoint

-- Drop indexes that have predicates referencing columns we're changing
DROP INDEX IF EXISTS "idx_customer_status";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_billing_status";--> statement-breakpoint

-- Drop CHECK constraints (no longer needed with ENUMs)
ALTER TABLE "customers" DROP CONSTRAINT "check_status";--> statement-breakpoint

-- Convert columns to ENUM types
ALTER TABLE "api_keys" ALTER COLUMN "service_type" SET DATA TYPE "public"."service_type" USING "service_type"::"public"."service_type";--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "status" SET DEFAULT 'active'::"public"."customer_status";--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "status" SET DATA TYPE "public"."customer_status" USING "status"::"public"."customer_status";--> statement-breakpoint
ALTER TABLE "billing_records" ALTER COLUMN "type" SET DATA TYPE "public"."transaction_type" USING "type"::"public"."transaction_type";--> statement-breakpoint
ALTER TABLE "billing_records" ALTER COLUMN "status" SET DATA TYPE "public"."billing_status" USING "status"::"public"."billing_status";--> statement-breakpoint
ALTER TABLE "escrow_transactions" ALTER COLUMN "tx_type" SET DATA TYPE "public"."transaction_type" USING "tx_type"::"public"."transaction_type";--> statement-breakpoint
ALTER TABLE "ledger_entries" ALTER COLUMN "type" SET DATA TYPE "public"."transaction_type" USING "type"::"public"."transaction_type";--> statement-breakpoint
ALTER TABLE "service_instances" ALTER COLUMN "service_type" SET DATA TYPE "public"."service_type" USING "service_type"::"public"."service_type";--> statement-breakpoint
ALTER TABLE "service_instances" ALTER COLUMN "state" SET DEFAULT 'not_provisioned'::"public"."service_state";--> statement-breakpoint
ALTER TABLE "service_instances" ALTER COLUMN "state" SET DATA TYPE "public"."service_state" USING "state"::"public"."service_state";--> statement-breakpoint
ALTER TABLE "service_instances" ALTER COLUMN "tier" SET DATA TYPE "public"."service_tier" USING "tier"::"public"."service_tier";--> statement-breakpoint

-- Recreate partial indexes (now work correctly with ENUM types)
CREATE INDEX IF NOT EXISTS "idx_customer_status" ON "customers" ("status") WHERE "status" != 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_status" ON "billing_records" ("status") WHERE "status" != 'paid';