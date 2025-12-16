-- Migration: Switch lm_status to sequence-based sync tracking
-- Remove inSync/fullSync booleans, use appliedSeq/processingSeq integers

-- Rename vault_seq to applied_seq
ALTER TABLE "lm_status" RENAME COLUMN "vault_seq" TO "applied_seq";

-- Add processing_seq column (nullable)
ALTER TABLE "lm_status" ADD COLUMN "processing_seq" integer;

-- Drop inSync and fullSync columns
ALTER TABLE "lm_status" DROP COLUMN "in_sync";
ALTER TABLE "lm_status" DROP COLUMN "full_sync";

-- Add next vault seq columns to system_control (one per vault type)
-- GM bumps to currentSeq+2 when starting vault generation, resets to newSeq+1 when done
-- API reads these to get the seq for configChangeVaultSeq
-- Seal mainnet vaults
ALTER TABLE "system_control" ADD COLUMN "sma_next_vault_seq" integer DEFAULT 1;
ALTER TABLE "system_control" ADD COLUMN "smm_next_vault_seq" integer DEFAULT 1;
ALTER TABLE "system_control" ADD COLUMN "sms_next_vault_seq" integer DEFAULT 1;
ALTER TABLE "system_control" ADD COLUMN "smo_next_vault_seq" integer DEFAULT 1;
-- Seal testnet vaults
ALTER TABLE "system_control" ADD COLUMN "sta_next_vault_seq" integer DEFAULT 1;
ALTER TABLE "system_control" ADD COLUMN "stm_next_vault_seq" integer DEFAULT 1;
ALTER TABLE "system_control" ADD COLUMN "sts_next_vault_seq" integer DEFAULT 1;
ALTER TABLE "system_control" ADD COLUMN "sto_next_vault_seq" integer DEFAULT 1;
-- Seal test/dev vault
ALTER TABLE "system_control" ADD COLUMN "skk_next_vault_seq" integer DEFAULT 1;

-- Add global max configChangeVaultSeq columns to system_control
-- API atomically updates these when setting service's configChangeVaultSeq
-- GM reads for O(1) hasPendingChanges check instead of MAX query over all services
ALTER TABLE "system_control" ADD COLUMN "sma_max_config_change_seq" integer DEFAULT 0;
ALTER TABLE "system_control" ADD COLUMN "sta_max_config_change_seq" integer DEFAULT 0;

-- Rename configChangeVaultSeq to include vault type (vault-specific tracking)
ALTER TABLE "service_instances" RENAME COLUMN "config_change_vault_seq" TO "sma_config_change_vault_seq";
