-- Add default values for customer billing fields
-- These defaults ensure new customers get proper initial values without explicit INSERT values

ALTER TABLE "customers" ALTER COLUMN "spending_limit_usd_cents" SET DEFAULT 25000;
ALTER TABLE "customers" ALTER COLUMN "current_balance_usd_cents" SET DEFAULT 0;
ALTER TABLE "customers" ALTER COLUMN "current_period_charged_usd_cents" SET DEFAULT 0;
