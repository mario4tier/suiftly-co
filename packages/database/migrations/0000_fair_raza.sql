CREATE TABLE "api_keys" (
	"api_key_id" varchar(100) PRIMARY KEY NOT NULL,
	"api_key_fp" varchar(64) NOT NULL,
	"customer_id" integer NOT NULL,
	"service_type" varchar(20) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp
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
CREATE TABLE "customers" (
	"customer_id" integer PRIMARY KEY NOT NULL,
	"wallet_address" varchar(66) NOT NULL,
	"escrow_contract_id" varchar(66),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"max_monthly_usd_cents" bigint,
	"current_balance_usd_cents" bigint,
	"current_month_charged_usd_cents" bigint,
	"last_month_charged_usd_cents" bigint,
	"current_month_start" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "customers_wallet_address_unique" UNIQUE("wallet_address"),
	CONSTRAINT "check_customer_id" CHECK ("customers"."customer_id" > 0),
	CONSTRAINT "check_status" CHECK ("customers"."status" IN ('active', 'suspended', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "billing_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" integer NOT NULL,
	"billing_period_start" timestamp NOT NULL,
	"billing_period_end" timestamp NOT NULL,
	"amount_usd_cents" bigint NOT NULL,
	"type" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"tx_digest" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escrow_transactions" (
	"tx_id" bigserial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"tx_digest" varchar(64) NOT NULL,
	"tx_type" varchar(20) NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"asset_type" varchar(66),
	"timestamp" timestamp NOT NULL,
	CONSTRAINT "escrow_transactions_tx_digest_unique" UNIQUE("tx_digest")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" integer NOT NULL,
	"type" varchar(20) NOT NULL,
	"amount_usd_cents" bigint NOT NULL,
	"amount_sui_mist" bigint,
	"sui_usd_rate_cents" bigint,
	"tx_hash" varchar(66),
	"description" text,
	"invoice_id" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_instances" (
	"instance_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" integer NOT NULL,
	"service_type" varchar(20) NOT NULL,
	"state" varchar(30) DEFAULT 'not_provisioned' NOT NULL,
	"tier" varchar(20) NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb,
	"enabled_at" timestamp,
	"disabled_at" timestamp,
	CONSTRAINT "service_instances_customer_id_service_type_unique" UNIQUE("customer_id","service_type")
);
--> statement-breakpoint
CREATE TABLE "seal_keys" (
	"seal_key_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" integer NOT NULL,
	"instance_id" uuid,
	"public_key" varchar(66) NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"purchase_tx_digest" varchar(64),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seal_packages" (
	"package_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seal_key_id" uuid NOT NULL,
	"package_address" varchar(66) NOT NULL,
	"name" varchar(100),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"record_id" bigserial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"service_type" varchar(20) NOT NULL,
	"request_count" bigint NOT NULL,
	"bytes_transferred" bigint,
	"window_start" timestamp NOT NULL,
	"window_end" timestamp NOT NULL,
	"charged_amount" numeric(20, 8)
);
--> statement-breakpoint
CREATE TABLE "haproxy_raw_logs" (
	"timestamp" timestamp with time zone NOT NULL,
	"customer_id" integer,
	"path_prefix" text,
	"config_hex" bigint,
	"network" smallint NOT NULL,
	"server_id" smallint NOT NULL,
	"service_type" smallint NOT NULL,
	"api_key_fp" integer NOT NULL,
	"fe_type" smallint NOT NULL,
	"traffic_type" smallint NOT NULL,
	"event_type" smallint NOT NULL,
	"client_ip" text NOT NULL,
	"key_metadata" smallint,
	"status_code" smallint NOT NULL,
	"bytes_sent" bigint DEFAULT 0 NOT NULL,
	"time_total" integer NOT NULL,
	"time_request" integer,
	"time_queue" integer,
	"time_connect" integer,
	"time_response" integer,
	"backend_id" smallint DEFAULT 0,
	"termination_state" text
);
--> statement-breakpoint
CREATE TABLE "config_global" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_tier_config" (
	"id" integer PRIMARY KEY NOT NULL,
	"starter_req_per_sec_region" integer DEFAULT 20 NOT NULL,
	"starter_req_per_sec_global" integer DEFAULT 60 NOT NULL,
	"starter_price" numeric(10, 2) DEFAULT '20.00' NOT NULL,
	"starter_burst_allowed" boolean DEFAULT false NOT NULL,
	"pro_req_per_sec_region" integer DEFAULT 300 NOT NULL,
	"pro_req_per_sec_global" integer DEFAULT 1200 NOT NULL,
	"pro_price" numeric(10, 2) DEFAULT '100.00' NOT NULL,
	"pro_burst_allowed" boolean DEFAULT true NOT NULL,
	"enterprise_req_per_sec_region" integer DEFAULT 1000 NOT NULL,
	"enterprise_req_per_sec_global" integer DEFAULT 4000 NOT NULL,
	"enterprise_price" numeric(10, 2) DEFAULT '300.00' NOT NULL,
	"enterprise_burst_allowed" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "check_singleton" CHECK ("service_tier_config"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "system_control" (
	"id" integer PRIMARY KEY NOT NULL,
	"ma_vault_version" varchar(64),
	"mm_vault_version" varchar(64),
	"last_monthly_reset" date,
	"maintenance_mode" boolean DEFAULT false,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "check_singleton" CHECK ("system_control"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_transactions" ADD CONSTRAINT "escrow_transactions_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_instances" ADD CONSTRAINT "service_instances_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seal_keys" ADD CONSTRAINT "seal_keys_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seal_keys" ADD CONSTRAINT "seal_keys_instance_id_service_instances_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."service_instances"("instance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seal_packages" ADD CONSTRAINT "seal_packages_seal_key_id_seal_keys_seal_key_id_fk" FOREIGN KEY ("seal_key_id") REFERENCES "public"."seal_keys"("seal_key_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haproxy_raw_logs" ADD CONSTRAINT "haproxy_raw_logs_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_customer_service" ON "api_keys" USING btree ("customer_id","service_type","is_active");--> statement-breakpoint
CREATE INDEX "idx_api_key_fp" ON "api_keys" USING btree ("api_key_fp") WHERE "api_keys"."is_active" = true;--> statement-breakpoint
CREATE INDEX "idx_created_at" ON "auth_nonces" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_refresh_customer" ON "refresh_tokens" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_expires_at" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_wallet" ON "customers" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "idx_customer_status" ON "customers" USING btree ("status") WHERE "customers"."status" != 'active';--> statement-breakpoint
CREATE INDEX "idx_customer_period" ON "billing_records" USING btree ("customer_id","billing_period_start");--> statement-breakpoint
CREATE INDEX "idx_billing_status" ON "billing_records" USING btree ("status") WHERE "billing_records"."status" != 'paid';--> statement-breakpoint
CREATE INDEX "idx_escrow_customer" ON "escrow_transactions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_escrow_tx_digest" ON "escrow_transactions" USING btree ("tx_digest");--> statement-breakpoint
CREATE INDEX "idx_customer_created" ON "ledger_entries" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ledger_tx_hash" ON "ledger_entries" USING btree ("tx_hash") WHERE "ledger_entries"."tx_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_seal_customer" ON "seal_keys" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_seal_instance" ON "seal_keys" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "idx_package_seal_key" ON "seal_packages" USING btree ("seal_key_id");--> statement-breakpoint
CREATE INDEX "idx_customer_time" ON "usage_records" USING btree ("customer_id","window_start");--> statement-breakpoint
CREATE INDEX "idx_billing" ON "usage_records" USING btree ("customer_id","service_type","window_start");--> statement-breakpoint
CREATE INDEX "idx_logs_customer_time" ON "haproxy_raw_logs" USING btree ("customer_id","timestamp" DESC NULLS LAST) WHERE "haproxy_raw_logs"."customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_logs_server_time" ON "haproxy_raw_logs" USING btree ("server_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_logs_service_network" ON "haproxy_raw_logs" USING btree ("service_type","network","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_logs_traffic_type" ON "haproxy_raw_logs" USING btree ("traffic_type","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_logs_event_type" ON "haproxy_raw_logs" USING btree ("event_type","timestamp" DESC NULLS LAST) WHERE "haproxy_raw_logs"."event_type" != 0;--> statement-breakpoint
CREATE INDEX "idx_logs_status_code" ON "haproxy_raw_logs" USING btree ("status_code","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_logs_api_key_fp" ON "haproxy_raw_logs" USING btree ("api_key_fp","timestamp" DESC NULLS LAST) WHERE "haproxy_raw_logs"."api_key_fp" != 0;--> statement-breakpoint
-- Insert initial configuration values
INSERT INTO "config_global" ("key", "value") VALUES
  ('fver', '1'),
  ('freg_count', '3'),
  ('fbw_sta', '3'),
  ('fbw_pro', '15'),
  ('fbw_ent', '100'),
  ('fsubs_usd_sta', '9'),
  ('fsubs_usd_pro', '29'),
  ('fsubs_usd_ent', '185'),
  ('freqs_usd', '1.00'),
  ('freqs_count', '10000'),
  ('fskey_incl', '1'),
  ('fskey_pkg_incl', '3'),
  ('fapikey_incl', '2'),
  ('fipv4_incl', '2'),
  ('fcidr_incl', '2'),
  ('fadd_skey_usd', '5'),
  ('fadd_pkg_usd', '1'),
  ('fadd_apikey_usd', '1'),
  ('fadd_ipv4_usd', '0'),
  ('fadd_cidr_usd', '0'),
  ('fmax_skey', '10'),
  ('fmax_pkg', '10'),
  ('fmax_apikey', '10'),
  ('fmax_ipv4', '20'),
  ('fmax_cidr', '20')
ON CONFLICT ("key") DO NOTHING;