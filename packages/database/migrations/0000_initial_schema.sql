CREATE TYPE "public"."billing_status" AS ENUM('draft', 'pending', 'paid', 'failed', 'voided');--> statement-breakpoint
CREATE TYPE "public"."billing_type" AS ENUM('immediate', 'scheduled');--> statement-breakpoint
CREATE TYPE "public"."customer_status" AS ENUM('active', 'suspended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."invoice_line_item_type" AS ENUM('subscription_starter', 'subscription_pro', 'subscription_enterprise', 'tier_upgrade', 'requests', 'extra_api_keys', 'extra_seal_keys', 'extra_allowlist_ips', 'extra_packages', 'credit', 'tax');--> statement-breakpoint
CREATE TYPE "public"."service_state" AS ENUM('not_provisioned', 'provisioning', 'disabled', 'enabled', 'suspended_maintenance', 'suspended_no_payment', 'cancellation_pending');--> statement-breakpoint
CREATE TYPE "public"."service_tier" AS ENUM('starter', 'pro', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."service_type" AS ENUM('seal', 'grpc', 'graphql');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('deposit', 'withdraw', 'charge', 'credit');--> statement-breakpoint
CREATE TYPE "public"."seal_registration_status" AS ENUM('registering', 'registered', 'updating');--> statement-breakpoint
CREATE TABLE "admin_notifications" (
	"notification_id" serial PRIMARY KEY NOT NULL,
	"severity" varchar(20) NOT NULL,
	"category" varchar(50) NOT NULL,
	"code" varchar(100) NOT NULL,
	"message" text NOT NULL,
	"details" text,
	"customer_id" varchar(50),
	"invoice_id" varchar(100),
	"acknowledged" boolean DEFAULT false NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"api_key_fp" integer PRIMARY KEY NOT NULL,
	"api_key_id" varchar(150) NOT NULL,
	"customer_id" integer NOT NULL,
	"service_type" "service_type" NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_user_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	"deleted_at" timestamp,
	CONSTRAINT "api_keys_api_key_id_unique" UNIQUE("api_key_id")
);
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"address" varchar(66) PRIMARY KEY NOT NULL,
	"nonce" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "billing_idempotency" (
	"idempotency_key" varchar(100) PRIMARY KEY NOT NULL,
	"billing_record_id" bigint,
	"response" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_credits" (
	"credit_id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"original_amount_usd_cents" bigint NOT NULL,
	"remaining_amount_usd_cents" bigint NOT NULL,
	"reason" varchar(50) NOT NULL,
	"description" text,
	"campaign_id" varchar(50),
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_remaining_not_negative" CHECK ("customer_credits"."remaining_amount_usd_cents" >= 0),
	CONSTRAINT "check_remaining_not_exceed_original" CHECK ("customer_credits"."remaining_amount_usd_cents" <= "customer_credits"."original_amount_usd_cents")
);
--> statement-breakpoint
CREATE TABLE "invoice_line_items" (
	"line_item_id" serial PRIMARY KEY NOT NULL,
	"billing_record_id" bigint NOT NULL,
	"item_type" "invoice_line_item_type" NOT NULL,
	"service_type" "service_type",
	"quantity" bigint DEFAULT 1 NOT NULL,
	"unit_price_usd_cents" bigint NOT NULL,
	"amount_usd_cents" bigint NOT NULL,
	"credit_month" varchar(20),
	"description" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_payments" (
	"payment_id" serial PRIMARY KEY NOT NULL,
	"billing_record_id" bigint NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"credit_id" integer,
	"escrow_transaction_id" bigint,
	"amount_usd_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_source_type_match" CHECK (
    ("invoice_payments"."source_type" = 'credit' AND "invoice_payments"."credit_id" IS NOT NULL AND "invoice_payments"."escrow_transaction_id" IS NULL) OR
    ("invoice_payments"."source_type" = 'escrow' AND "invoice_payments"."escrow_transaction_id" IS NOT NULL AND "invoice_payments"."credit_id" IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "service_cancellation_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"service_type" "service_type" NOT NULL,
	"previous_tier" "service_tier" NOT NULL,
	"billing_period_ended_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	"cooldown_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"customer_id" integer PRIMARY KEY NOT NULL,
	"wallet_address" varchar(66) NOT NULL,
	"escrow_contract_id" varchar(66),
	"status" "customer_status" DEFAULT 'active' NOT NULL,
	"spending_limit_usd_cents" bigint DEFAULT 25000,
	"current_balance_usd_cents" bigint DEFAULT 0,
	"current_period_charged_usd_cents" bigint DEFAULT 0,
	"current_period_start" date,
	"paid_once" boolean DEFAULT false NOT NULL,
	"grace_period_start" date,
	"grace_period_notified_at" timestamp with time zone[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "customers_wallet_address_unique" UNIQUE("wallet_address"),
	CONSTRAINT "check_customer_id" CHECK ("customers"."customer_id" != 0)
);
--> statement-breakpoint
CREATE TABLE "billing_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"billing_period_start" timestamp NOT NULL,
	"billing_period_end" timestamp NOT NULL,
	"amount_usd_cents" bigint NOT NULL,
	"type" "transaction_type" NOT NULL,
	"status" "billing_status" NOT NULL,
	"tx_digest" "bytea",
	"due_date" timestamp with time zone,
	"billing_type" "billing_type" DEFAULT 'scheduled' NOT NULL,
	"amount_paid_usd_cents" bigint DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0,
	"last_retry_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_updated_at" timestamp,
	CONSTRAINT "check_tx_digest_length" CHECK ("billing_records"."tx_digest" IS NULL OR LENGTH("billing_records"."tx_digest") = 32)
);
--> statement-breakpoint
CREATE TABLE "escrow_transactions" (
	"tx_id" bigserial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"tx_digest" "bytea" NOT NULL,
	"tx_type" "transaction_type" NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"asset_type" varchar(66),
	"timestamp" timestamp NOT NULL,
	CONSTRAINT "escrow_transactions_tx_digest_unique" UNIQUE("tx_digest"),
	CONSTRAINT "check_tx_digest_length" CHECK (LENGTH("escrow_transactions"."tx_digest") = 32)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" integer NOT NULL,
	"type" "transaction_type" NOT NULL,
	"amount_usd_cents" bigint NOT NULL,
	"amount_sui_mist" bigint,
	"sui_usd_rate_cents" bigint,
	"tx_digest" "bytea",
	"description" text,
	"invoice_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_tx_digest_length" CHECK ("ledger_entries"."tx_digest" IS NULL OR LENGTH("ledger_entries"."tx_digest") = 32)
);
--> statement-breakpoint
CREATE TABLE "service_instances" (
	"instance_id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"service_type" "service_type" NOT NULL,
	"state" "service_state" DEFAULT 'not_provisioned' NOT NULL,
	"tier" "service_tier" NOT NULL,
	"is_user_enabled" boolean DEFAULT true NOT NULL,
	"sub_pending_invoice_id" bigint,
	"paid_once" boolean DEFAULT false NOT NULL,
	"config" jsonb,
	"enabled_at" timestamp,
	"disabled_at" timestamp,
	"scheduled_tier" "service_tier",
	"scheduled_tier_effective_date" date,
	"cancellation_scheduled_for" date,
	"cancellation_effective_at" timestamp with time zone,
	"last_billed_timestamp" timestamp,
	"sma_config_change_vault_seq" integer DEFAULT 0,
	"cp_enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "service_instances_customer_id_service_type_unique" UNIQUE("customer_id","service_type")
);
--> statement-breakpoint
CREATE TABLE "seal_keys" (
	"seal_key_id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"instance_id" integer,
	"name" text,
	"derivation_index" integer,
	"encrypted_private_key" text,
	"public_key" "bytea" NOT NULL,
	"object_id" "bytea",
	"register_txn_digest" "bytea",
	"process_group" integer DEFAULT 1 NOT NULL,
	"registration_status" "seal_registration_status" DEFAULT 'registering' NOT NULL,
	"registration_error" text,
	"registration_attempts" integer DEFAULT 0 NOT NULL,
	"last_registration_attempt_at" timestamp,
	"next_retry_at" timestamp,
	"packages_version" integer DEFAULT 0 NOT NULL,
	"registered_packages_version" integer,
	"is_user_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "check_name_length" CHECK ("seal_keys"."name" IS NULL OR LENGTH("seal_keys"."name") <= 64),
	CONSTRAINT "check_public_key_length" CHECK (LENGTH("seal_keys"."public_key") IN (48, 96)),
	CONSTRAINT "check_object_id_length" CHECK ("seal_keys"."object_id" IS NULL OR LENGTH("seal_keys"."object_id") = 32),
	CONSTRAINT "check_register_txn_digest_length" CHECK ("seal_keys"."register_txn_digest" IS NULL OR LENGTH("seal_keys"."register_txn_digest") = 32),
	CONSTRAINT "check_key_source" CHECK (("seal_keys"."derivation_index" IS NOT NULL AND "seal_keys"."encrypted_private_key" IS NULL) OR
        ("seal_keys"."derivation_index" IS NULL AND "seal_keys"."encrypted_private_key" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "seal_packages" (
	"package_id" serial PRIMARY KEY NOT NULL,
	"seal_key_id" integer NOT NULL,
	"package_address" "bytea" NOT NULL,
	"name" text,
	"is_user_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "check_package_address_length" CHECK (LENGTH("seal_packages"."package_address") = 32),
	CONSTRAINT "check_name_length" CHECK ("seal_packages"."name" IS NULL OR LENGTH("seal_packages"."name") <= 64)
);
--> statement-breakpoint
CREATE TABLE "seal_registration_ops" (
	"op_id" serial PRIMARY KEY NOT NULL,
	"seal_key_id" integer NOT NULL,
	"customer_id" integer NOT NULL,
	"network" text NOT NULL,
	"op_type" text NOT NULL,
	"status" text NOT NULL,
	"packages_version_at_op" integer NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp,
	"tx_digest" "bytea",
	"object_id" "bytea",
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	CONSTRAINT "check_tx_digest_length" CHECK ("seal_registration_ops"."tx_digest" IS NULL OR LENGTH("seal_registration_ops"."tx_digest") = 32),
	CONSTRAINT "check_op_object_id_length" CHECK ("seal_registration_ops"."object_id" IS NULL OR LENGTH("seal_registration_ops"."object_id") = 32)
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"record_id" bigserial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"service_type" "service_type" NOT NULL,
	"request_count" bigint NOT NULL,
	"bytes_transferred" bigint,
	"window_start" timestamp NOT NULL,
	"window_end" timestamp NOT NULL,
	"charged_amount" numeric(20, 8)
);
--> statement-breakpoint
CREATE TABLE "haproxy_raw_logs" (
	"timestamp" timestamp with time zone NOT NULL,
	"customer_id" bigint,
	"path_prefix" text,
	"config_hex" bigint,
	"network" smallint NOT NULL,
	"server_id" smallint NOT NULL,
	"service_type" smallint NOT NULL,
	"api_key_fp" bigint NOT NULL,
	"fe_type" smallint NOT NULL,
	"traffic_type" smallint NOT NULL,
	"event_type" smallint NOT NULL,
	"client_ip" "inet" NOT NULL,
	"key_metadata" smallint,
	"status_code" smallint NOT NULL,
	"bytes_sent" bigint DEFAULT 0 NOT NULL,
	"time_total" integer NOT NULL,
	"time_request" integer,
	"time_queue" integer,
	"time_connect" integer,
	"time_response" integer,
	"backend_id" smallint DEFAULT 0,
	"termination_state" text,
	"repeat" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "haproxy_system_logs" (
	"timestamp" timestamp with time zone NOT NULL,
	"server_id" smallint NOT NULL,
	"msg" text NOT NULL,
	"cnt" smallint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_activity_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"client_ip" "inet" NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_global" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lm_status" (
	"lm_id" varchar(64) NOT NULL,
	"display_name" varchar(128),
	"host" varchar(256) NOT NULL,
	"region" varchar(64),
	"vault_type" varchar(8) NOT NULL,
	"applied_seq" integer DEFAULT 0,
	"processing_seq" integer,
	"customer_count" integer DEFAULT 0,
	"last_seen_at" timestamp,
	"last_error_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lm_status_lm_id_vault_type_pk" PRIMARY KEY("lm_id","vault_type")
);
--> statement-breakpoint
CREATE TABLE "processing_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_control" (
	"id" integer PRIMARY KEY NOT NULL,
	"sma_vault_seq" integer DEFAULT 0,
	"smk_vault_seq" integer DEFAULT 0,
	"smo_vault_seq" integer DEFAULT 0,
	"sta_vault_seq" integer DEFAULT 0,
	"stk_vault_seq" integer DEFAULT 0,
	"sto_vault_seq" integer DEFAULT 0,
	"skk_vault_seq" integer DEFAULT 0,
	"sma_next_vault_seq" integer DEFAULT 1,
	"smk_next_vault_seq" integer DEFAULT 1,
	"smo_next_vault_seq" integer DEFAULT 1,
	"sta_next_vault_seq" integer DEFAULT 1,
	"stk_next_vault_seq" integer DEFAULT 1,
	"sto_next_vault_seq" integer DEFAULT 1,
	"skk_next_vault_seq" integer DEFAULT 1,
	"sma_max_config_change_seq" integer DEFAULT 0,
	"sta_max_config_change_seq" integer DEFAULT 0,
	"sma_vault_content_hash" varchar(16),
	"smk_vault_content_hash" varchar(16),
	"smo_vault_content_hash" varchar(16),
	"sta_vault_content_hash" varchar(16),
	"stk_vault_content_hash" varchar(16),
	"sto_vault_content_hash" varchar(16),
	"skk_vault_content_hash" varchar(16),
	"sma_vault_entries" integer DEFAULT 0,
	"smk_vault_entries" integer DEFAULT 0,
	"smo_vault_entries" integer DEFAULT 0,
	"sta_vault_entries" integer DEFAULT 0,
	"stk_vault_entries" integer DEFAULT 0,
	"sto_vault_entries" integer DEFAULT 0,
	"skk_vault_entries" integer DEFAULT 0,
	"next_seal_derivation_index_pg1" integer DEFAULT 1 NOT NULL,
	"next_seal_derivation_index_pg2" integer DEFAULT 1 NOT NULL,
	"last_monthly_reset" date,
	"maintenance_mode" boolean DEFAULT false,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "check_singleton" CHECK ("system_control"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "mock_sui_transactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"tx_digest" varchar(66) NOT NULL,
	"tx_type" varchar(20) NOT NULL,
	"amount_usd_cents" bigint NOT NULL,
	"description" text,
	"success" varchar(5) DEFAULT 'true' NOT NULL,
	"error_message" text,
	"checkpoint" bigint,
	"balance_after_usd_cents" bigint,
	"spending_limit_usd_cents" bigint,
	"period_charged_after_usd_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock_tracking_objects" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tracking_address" varchar(66) NOT NULL,
	"owner" varchar(10) NOT NULL,
	"user_address" varchar(66) NOT NULL,
	"escrow_address" varchar(66) NOT NULL,
	"created_by_tx" varchar(66) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconciled" varchar(5) DEFAULT 'false' NOT NULL,
	"reconciled_at" timestamp with time zone,
	CONSTRAINT "mock_tracking_objects_tracking_address_unique" UNIQUE("tracking_address")
);
--> statement-breakpoint
CREATE TABLE "test_kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_idempotency" ADD CONSTRAINT "billing_idempotency_billing_record_id_billing_records_id_fk" FOREIGN KEY ("billing_record_id") REFERENCES "public"."billing_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credits" ADD CONSTRAINT "customer_credits_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_billing_record_id_billing_records_id_fk" FOREIGN KEY ("billing_record_id") REFERENCES "public"."billing_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_billing_record_id_billing_records_id_fk" FOREIGN KEY ("billing_record_id") REFERENCES "public"."billing_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_credit_id_customer_credits_credit_id_fk" FOREIGN KEY ("credit_id") REFERENCES "public"."customer_credits"("credit_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_escrow_transaction_id_escrow_transactions_tx_id_fk" FOREIGN KEY ("escrow_transaction_id") REFERENCES "public"."escrow_transactions"("tx_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_cancellation_history" ADD CONSTRAINT "service_cancellation_history_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_transactions" ADD CONSTRAINT "escrow_transactions_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_instances" ADD CONSTRAINT "service_instances_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_instances" ADD CONSTRAINT "service_instances_sub_pending_invoice_id_billing_records_id_fk" FOREIGN KEY ("sub_pending_invoice_id") REFERENCES "public"."billing_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seal_keys" ADD CONSTRAINT "seal_keys_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seal_keys" ADD CONSTRAINT "seal_keys_instance_id_service_instances_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."service_instances"("instance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seal_packages" ADD CONSTRAINT "seal_packages_seal_key_id_seal_keys_seal_key_id_fk" FOREIGN KEY ("seal_key_id") REFERENCES "public"."seal_keys"("seal_key_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seal_registration_ops" ADD CONSTRAINT "seal_registration_ops_seal_key_id_seal_keys_seal_key_id_fk" FOREIGN KEY ("seal_key_id") REFERENCES "public"."seal_keys"("seal_key_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_activity_logs" ADD CONSTRAINT "user_activity_logs_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_sui_transactions" ADD CONSTRAINT "mock_sui_transactions_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_admin_notif_severity" ON "admin_notifications" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "idx_admin_notif_category" ON "admin_notifications" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_admin_notif_acknowledged" ON "admin_notifications" USING btree ("acknowledged") WHERE "admin_notifications"."acknowledged" = false;--> statement-breakpoint
CREATE INDEX "idx_admin_notif_created" ON "admin_notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_admin_notif_customer" ON "admin_notifications" USING btree ("customer_id") WHERE "admin_notifications"."customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_customer_service" ON "api_keys" USING btree ("customer_id","service_type","is_user_enabled");--> statement-breakpoint
CREATE INDEX "idx_created_at" ON "auth_nonces" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_refresh_customer" ON "refresh_tokens" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_expires_at" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_idempotency_created" ON "billing_idempotency" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_credit_customer" ON "customer_credits" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_credit_expires" ON "customer_credits" USING btree ("expires_at") WHERE "customer_credits"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_line_items_billing" ON "invoice_line_items" USING btree ("billing_record_id");--> statement-breakpoint
CREATE INDEX "idx_payment_billing_record" ON "invoice_payments" USING btree ("billing_record_id");--> statement-breakpoint
CREATE INDEX "idx_payment_credit" ON "invoice_payments" USING btree ("credit_id") WHERE "invoice_payments"."credit_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_payment_escrow" ON "invoice_payments" USING btree ("escrow_transaction_id") WHERE "invoice_payments"."escrow_transaction_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_cancellation_customer_service" ON "service_cancellation_history" USING btree ("customer_id","service_type");--> statement-breakpoint
CREATE INDEX "idx_cancellation_cooldown" ON "service_cancellation_history" USING btree ("cooldown_expires_at");--> statement-breakpoint
CREATE INDEX "idx_wallet" ON "customers" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "idx_customer_status" ON "customers" USING btree ("status") WHERE "customers"."status" != 'active';--> statement-breakpoint
CREATE INDEX "idx_customer_period" ON "billing_records" USING btree ("customer_id","billing_period_start");--> statement-breakpoint
CREATE INDEX "idx_billing_status" ON "billing_records" USING btree ("status") WHERE "billing_records"."status" != 'paid';--> statement-breakpoint
CREATE INDEX "idx_billing_type_status" ON "billing_records" USING btree ("billing_type","status") WHERE "billing_records"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_escrow_customer" ON "escrow_transactions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_escrow_tx_digest" ON "escrow_transactions" USING btree ("tx_digest");--> statement-breakpoint
CREATE INDEX "idx_customer_created" ON "ledger_entries" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ledger_tx_digest" ON "ledger_entries" USING btree ("tx_digest") WHERE "ledger_entries"."tx_digest" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_service_type_state" ON "service_instances" USING btree ("service_type","state");--> statement-breakpoint
CREATE INDEX "idx_service_cancellation_scheduled" ON "service_instances" USING btree ("cancellation_scheduled_for") WHERE "service_instances"."cancellation_scheduled_for" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_service_cancellation_pending" ON "service_instances" USING btree ("state","cancellation_effective_at") WHERE "service_instances"."state" = 'cancellation_pending';--> statement-breakpoint
CREATE INDEX "idx_service_scheduled_tier" ON "service_instances" USING btree ("scheduled_tier_effective_date") WHERE "service_instances"."scheduled_tier" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_seal_customer" ON "seal_keys" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_seal_instance" ON "seal_keys" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "idx_seal_public_key" ON "seal_keys" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX "idx_seal_object_id" ON "seal_keys" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "idx_package_seal_key" ON "seal_packages" USING btree ("seal_key_id");--> statement-breakpoint
CREATE INDEX "idx_package_address" ON "seal_packages" USING btree ("package_address");--> statement-breakpoint
CREATE INDEX "idx_seal_reg_ops_queued" ON "seal_registration_ops" USING btree ("status","next_retry_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_seal_reg_ops_seal_key" ON "seal_registration_ops" USING btree ("seal_key_id");--> statement-breakpoint
CREATE INDEX "idx_customer_time" ON "usage_records" USING btree ("customer_id","window_start");--> statement-breakpoint
CREATE INDEX "idx_billing" ON "usage_records" USING btree ("customer_id","service_type","window_start");--> statement-breakpoint
CREATE INDEX "idx_logs_customer_time" ON "haproxy_raw_logs" USING btree ("customer_id","timestamp" DESC NULLS LAST) WHERE "haproxy_raw_logs"."customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_logs_server_time" ON "haproxy_raw_logs" USING btree ("server_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_logs_service_network" ON "haproxy_raw_logs" USING btree ("service_type","network","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_logs_traffic_type" ON "haproxy_raw_logs" USING btree ("traffic_type","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_logs_event_type" ON "haproxy_raw_logs" USING btree ("event_type","timestamp" DESC NULLS LAST) WHERE "haproxy_raw_logs"."event_type" != 0;--> statement-breakpoint
CREATE INDEX "idx_logs_status_code" ON "haproxy_raw_logs" USING btree ("status_code","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_logs_api_key_fp" ON "haproxy_raw_logs" USING btree ("api_key_fp","timestamp" DESC NULLS LAST) WHERE "haproxy_raw_logs"."api_key_fp" != 0;--> statement-breakpoint
CREATE INDEX "idx_system_server_time" ON "haproxy_system_logs" USING btree ("server_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_activity_customer_time" ON "user_activity_logs" USING btree ("customer_id","timestamp" DESC NULLS LAST);