CREATE TABLE "config_global" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

-- Seed initial configuration values
-- Frontend configuration (f*)
INSERT INTO "config_global" ("key", "value") VALUES
  -- Version tracking (increment when important fields change to trigger client reload)
  ('fver', '1'),

  -- Region count (for calculating global bandwidth)
  ('freg_count', '3'),

  -- Tier bandwidth (req/s per region)
  ('fbw_sta', '3'),
  ('fbw_pro', '15'),
  ('fbw_bus', '100'),

  -- Tier subscription fees (USD/month)
  ('fsubs_usd_sta', '9'),
  ('fsubs_usd_pro', '29'),
  ('fsubs_usd_bus', '185'),

  -- Usage-based pricing
  ('freqs_usd', '1.00'),
  ('freqs_count', '10000'),

  -- Included features
  ('fskey_incl', '1'),
  ('fskey_pkg_incl', '3')
ON CONFLICT ("key") DO NOTHING;

-- Backend configuration (b*)
INSERT INTO "config_global" ("key", "value") VALUES
  -- Guaranteed limits for backend (req/s)
  ('bglim_sta', '3'),
  ('bglim_pro', '15'),
  ('bglim_bus', '100')
ON CONFLICT ("key") DO NOTHING;
