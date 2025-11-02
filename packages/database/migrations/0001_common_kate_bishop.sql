CREATE TABLE "service_tier_config" (
	"id" integer PRIMARY KEY NOT NULL,
	"basic_req_per_sec_region" integer DEFAULT 20 NOT NULL,
	"basic_req_per_sec_global" integer DEFAULT 60 NOT NULL,
	"basic_price" numeric(10, 2) DEFAULT '20.00' NOT NULL,
	"basic_burst_allowed" boolean DEFAULT false NOT NULL,
	"pro_req_per_sec_region" integer DEFAULT 300 NOT NULL,
	"pro_req_per_sec_global" integer DEFAULT 1200 NOT NULL,
	"pro_price" numeric(10, 2) DEFAULT '100.00' NOT NULL,
	"pro_burst_allowed" boolean DEFAULT true NOT NULL,
	"business_req_per_sec_region" integer DEFAULT 1000 NOT NULL,
	"business_req_per_sec_global" integer DEFAULT 4000 NOT NULL,
	"business_price" numeric(10, 2) DEFAULT '300.00' NOT NULL,
	"business_burst_allowed" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "check_singleton" CHECK ("service_tier_config"."id" = 1)
);
