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
ALTER TABLE "mock_sui_transactions" ADD CONSTRAINT "mock_sui_transactions_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;