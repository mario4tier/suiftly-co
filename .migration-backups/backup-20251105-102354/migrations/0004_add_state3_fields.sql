-- Migration 0004: Add State 3 interactive form fields
-- Adds missing fields for service configuration, packages, and config_global entries

-- 0. Rename basic tier columns to starter in service_tier_config table
DO $$
BEGIN
  -- Only rename if basic columns exist (avoid errors if already renamed)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'service_tier_config' AND column_name = 'basic_req_per_sec_region'
  ) THEN
    ALTER TABLE "service_tier_config" RENAME COLUMN "basic_req_per_sec_region" TO "starter_req_per_sec_region";
    ALTER TABLE "service_tier_config" RENAME COLUMN "basic_req_per_sec_global" TO "starter_req_per_sec_global";
    ALTER TABLE "service_tier_config" RENAME COLUMN "basic_price" TO "starter_price";
    ALTER TABLE "service_tier_config" RENAME COLUMN "basic_burst_allowed" TO "starter_burst_allowed";
  END IF;
END $$;

-- 1. Add state column to service_instances (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'service_instances' AND column_name = 'state'
  ) THEN
    ALTER TABLE "service_instances"
    ADD COLUMN "state" varchar(30) NOT NULL DEFAULT 'not_provisioned';
  END IF;
END $$;

-- 2. Create seal_packages table
CREATE TABLE IF NOT EXISTS "seal_packages" (
  "package_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seal_key_id" uuid NOT NULL,
  "package_address" varchar(66) NOT NULL,
  "name" varchar(100),
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Add foreign key constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'seal_packages_seal_key_id_fk'
  ) THEN
    ALTER TABLE "seal_packages"
    ADD CONSTRAINT "seal_packages_seal_key_id_fk"
    FOREIGN KEY ("seal_key_id") REFERENCES "seal_keys"("seal_key_id") ON DELETE cascade;
  END IF;
END $$;

-- Create index for seal_packages
CREATE INDEX IF NOT EXISTS "idx_package_seal_key" ON "seal_packages" ("seal_key_id");

-- 3. Add instance_id to seal_keys (link seal keys to service instance)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seal_keys' AND column_name = 'instance_id'
  ) THEN
    ALTER TABLE "seal_keys"
    ADD COLUMN "instance_id" uuid;
  END IF;
END $$;

-- Add foreign key constraint for instance_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'seal_keys_instance_id_fk'
  ) THEN
    ALTER TABLE "seal_keys"
    ADD CONSTRAINT "seal_keys_instance_id_fk"
    FOREIGN KEY ("instance_id") REFERENCES "service_instances"("instance_id") ON DELETE cascade;
  END IF;
END $$;

-- Create index for instance_id
CREATE INDEX IF NOT EXISTS "idx_seal_instance" ON "seal_keys" ("instance_id");

-- 4. Add config_global entries for included item counts (frontend configuration)
INSERT INTO "config_global" ("key", "value") VALUES
  -- Included feature counts (base subscription includes these)
  ('fskey_incl', '1'),           -- 1 Seal Key included
  ('fskey_pkg_incl', '3'),       -- 3 Packages per Seal Key included
  ('fapikey_incl', '2'),         -- 2 API Keys included
  ('fipv4_incl', '2'),           -- 2 IPv4 addresses in allowlist included (Pro/Enterprise)
  ('fcidr_incl', '2')            -- 2 CIDR ranges in allowlist included (Enterprise only)
ON CONFLICT ("key") DO UPDATE SET
  "value" = EXCLUDED."value",
  "updated_at" = now();

-- 5. Add config_global entries for add-on pricing (per additional item beyond included)
INSERT INTO "config_global" ("key", "value") VALUES
  -- Add-on pricing (USD/month per additional item)
  ('fadd_skey_usd', '5'),        -- $5/month per additional Seal Key
  ('fadd_pkg_usd', '1'),         -- $1/month per additional Package (per key)
  ('fadd_apikey_usd', '1'),      -- $1/month per additional API Key
  ('fadd_ipv4_usd', '0'),        -- $0/month per additional IPv4 (included with tier)
  ('fadd_cidr_usd', '0')         -- $0/month per additional CIDR (included with tier)
ON CONFLICT ("key") DO UPDATE SET
  "value" = EXCLUDED."value",
  "updated_at" = now();

-- 6. Add config_global entries for maximum item limits (per user/service)
INSERT INTO "config_global" ("key", "value") VALUES
  -- Maximum item counts (hard limits for user purchases)
  ('fmax_skey', '10'),           -- Max 10 Seal Keys per service
  ('fmax_pkg', '10'),            -- Max 10 Packages per Seal Key
  ('fmax_apikey', '10'),         -- Max 10 API Keys per service
  ('fmax_ipv4', '20'),           -- Max 20 IPv4 addresses in allowlist
  ('fmax_cidr', '20')            -- Max 20 CIDR ranges in allowlist
ON CONFLICT ("key") DO UPDATE SET
  "value" = EXCLUDED."value",
  "updated_at" = now();
