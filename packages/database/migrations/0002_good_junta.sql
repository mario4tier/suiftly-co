ALTER TABLE "lm_status" DROP CONSTRAINT "lm_status_pkey";--> statement-breakpoint
ALTER TABLE "lm_status" ALTER COLUMN "vault_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "system_control" ALTER COLUMN "next_seal_derivation_index_pg1" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "system_control" ALTER COLUMN "next_seal_derivation_index_pg2" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "lm_status" ADD CONSTRAINT "lm_status_lm_id_vault_type_pk" PRIMARY KEY("lm_id","vault_type");