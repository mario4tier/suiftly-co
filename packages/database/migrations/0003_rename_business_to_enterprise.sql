-- Rename business tier columns to enterprise in service_tier_config table
ALTER TABLE "service_tier_config" RENAME COLUMN "business_req_per_sec_region" TO "enterprise_req_per_sec_region";
ALTER TABLE "service_tier_config" RENAME COLUMN "business_req_per_sec_global" TO "enterprise_req_per_sec_global";
ALTER TABLE "service_tier_config" RENAME COLUMN "business_price" TO "enterprise_price";
ALTER TABLE "service_tier_config" RENAME COLUMN "business_burst_allowed" TO "enterprise_burst_allowed";

-- Rename config_global keys from _bus suffix to _ent suffix
UPDATE "config_global" SET "key" = 'fbw_ent' WHERE "key" = 'fbw_bus';
UPDATE "config_global" SET "key" = 'fsubs_usd_ent' WHERE "key" = 'fsubs_usd_bus';
UPDATE "config_global" SET "key" = 'bglim_ent' WHERE "key" = 'bglim_bus';
