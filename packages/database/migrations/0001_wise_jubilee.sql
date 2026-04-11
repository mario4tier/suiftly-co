ALTER TABLE "service_instances" ADD COLUMN "rma_config_change_vault_seq" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "rma_vault_seq" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "rta_vault_seq" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "rkk_vault_seq" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "rma_next_vault_seq" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "rta_next_vault_seq" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "rkk_next_vault_seq" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "rma_max_config_change_seq" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "rta_max_config_change_seq" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "rma_vault_content_hash" varchar(16);--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "rta_vault_content_hash" varchar(16);--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "rkk_vault_content_hash" varchar(16);--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "rma_vault_entries" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "rta_vault_entries" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "rkk_vault_entries" integer DEFAULT 0;