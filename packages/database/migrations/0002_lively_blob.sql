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
