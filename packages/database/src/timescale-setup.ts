import { sql } from 'drizzle-orm';
import { db } from './db';

/**
 * Configure TimescaleDB hypertable for haproxy_raw_logs.
 * Run this AFTER creating the schema with drizzle-kit push.
 *
 * Based on walrus HAPROXY_LOGS.md specification:
 * - 1-hour chunks for faster pruning
 * - 6-hour compression policy
 * - 7-day retention (raw logs)
 * - Continuous aggregates preserve long-term data
 */
export async function setupTimescaleDB() {
  console.log('Setting up TimescaleDB for haproxy_raw_logs...');

  // Convert haproxy_raw_logs to hypertable (run AFTER schema creation)
  await db.execute(sql`
    SELECT create_hypertable('haproxy_raw_logs', 'timestamp',
      chunk_time_interval => INTERVAL '1 hour',
      if_not_exists => TRUE
    );
  `);
  console.log('✓ Created hypertable');

  // Enable compression
  await db.execute(sql`
    ALTER TABLE haproxy_raw_logs SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'server_id,service_type,network',
      timescaledb.compress_orderby = 'timestamp DESC'
    );
  `);
  console.log('✓ Enabled compression');

  // Add compression policy (compress after 6 hours)
  await db.execute(sql`
    SELECT add_compression_policy('haproxy_raw_logs', INTERVAL '6 hours', if_not_exists => TRUE);
  `);
  console.log('✓ Added compression policy (6 hours)');

  // Add retention policy (auto-delete raw data older than 7 days)
  await db.execute(sql`
    SELECT add_retention_policy('haproxy_raw_logs', INTERVAL '7 days', if_not_exists => TRUE);
  `);
  console.log('✓ Added retention policy (7 days)');

  // =========================================================================
  // HAProxy System Logs (ALERT, WARNING, etc.)
  // =========================================================================

  // Create table if it doesn't exist (schema may not have migrated yet)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS haproxy_system_logs (
      timestamp TIMESTAMPTZ NOT NULL,
      server_id SMALLINT NOT NULL,
      msg TEXT NOT NULL,
      cnt SMALLINT NOT NULL DEFAULT 1
    );
  `);

  // Create index if it doesn't exist
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_system_server_time
    ON haproxy_system_logs (server_id, timestamp DESC);
  `);

  // Convert haproxy_system_logs to hypertable
  await db.execute(sql`
    SELECT create_hypertable('haproxy_system_logs', 'timestamp',
      chunk_time_interval => INTERVAL '1 day',
      if_not_exists => TRUE
    );
  `);
  console.log('✓ Created haproxy_system_logs hypertable');

  // Add retention policy (7 days - same as request logs)
  await db.execute(sql`
    SELECT add_retention_policy('haproxy_system_logs', INTERVAL '7 days', if_not_exists => TRUE);
  `);
  console.log('✓ Added haproxy_system_logs retention policy (7 days)');

  // =========================================================================
  // Stats Continuous Aggregate (STATS_DESIGN.md D2)
  // =========================================================================

  // Create continuous aggregate for hourly stats (STATS_DESIGN.md D2)
  // Uses SUM(repeat) instead of COUNT(*) to support pre-aggregated logs from HAProxy
  // When repeat=1 (default), SUM(repeat) equals COUNT(*). When repeat>1, it properly counts
  // all the requests that a single aggregated log entry represents.
  await db.execute(sql`
    CREATE MATERIALIZED VIEW IF NOT EXISTS stats_per_hour
    WITH (timescaledb.continuous) AS
    SELECT
      time_bucket('1 hour', timestamp) AS bucket,
      customer_id,
      service_type,
      network,
      -- Traffic breakdown (for stacked Traffic chart)
      -- Uses SUM(repeat) to support pre-aggregated logs
      SUM(repeat) FILTER (WHERE traffic_type = 1 AND status_code >= 200 AND status_code < 300) AS guaranteed_success_count,
      SUM(repeat) FILTER (WHERE traffic_type = 2 AND status_code >= 200 AND status_code < 300) AS burst_success_count,
      SUM(repeat) FILTER (WHERE traffic_type IN (3, 4, 5, 6)) AS dropped_count,
      -- Error breakdown (exclude dropped traffic - those have their own category)
      SUM(repeat) FILTER (WHERE status_code >= 400 AND status_code < 500 AND traffic_type NOT IN (3, 4, 5, 6)) AS client_error_count,
      SUM(repeat) FILTER (WHERE status_code >= 500 AND traffic_type NOT IN (3, 4, 5, 6)) AS server_error_count,
      -- Billing (guaranteed + burst, regardless of status)
      SUM(repeat) FILTER (WHERE traffic_type IN (1, 2)) AS billable_requests,
      -- Legacy/summary (all 2xx)
      SUM(repeat) FILTER (WHERE status_code >= 200 AND status_code < 300) AS success_count,
      -- Performance (weighted average for pre-aggregated logs)
      SUM(time_total::bigint * repeat)::double precision / NULLIF(SUM(repeat), 0) AS avg_response_time_ms,
      SUM(bytes_sent * repeat) AS total_bytes
    FROM haproxy_raw_logs
    WHERE customer_id IS NOT NULL
    GROUP BY bucket, customer_id, service_type, network;
  `);
  console.log('✓ Created stats_per_hour continuous aggregate');

  // Add refresh policy: refresh every 5 minutes, with 10 minute lag
  await db.execute(sql`
    SELECT add_continuous_aggregate_policy('stats_per_hour',
      start_offset => INTERVAL '1 day',
      end_offset => INTERVAL '10 minutes',
      schedule_interval => INTERVAL '5 minutes',
      if_not_exists => TRUE
    );
  `);
  console.log('✓ Added stats_per_hour refresh policy');

  // Add retention policy: keep 90 days of hourly stats
  await db.execute(sql`
    SELECT add_retention_policy('stats_per_hour', INTERVAL '90 days', if_not_exists => TRUE);
  `);
  console.log('✓ Added stats_per_hour retention policy (90 days)');

  // Create indexes on continuous aggregate for efficient queries
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_stats_per_hour_customer_bucket
    ON stats_per_hour (customer_id, bucket DESC);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_stats_per_hour_service_bucket
    ON stats_per_hour (service_type, bucket DESC);
  `);
  console.log('✓ Created stats_per_hour indexes');

  // Transfer ownership to deploy user for runtime operations
  // This allows the API to read stats and refresh the aggregate for testing
  // Note: refresh_continuous_aggregate requires being the owner
  await db.execute(sql`ALTER MATERIALIZED VIEW stats_per_hour OWNER TO deploy`);
  console.log('✓ Transferred stats_per_hour ownership to deploy');

  console.log('✅ TimescaleDB setup complete');
}

// Allow running directly: tsx src/timescale-setup.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  setupTimescaleDB()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ TimescaleDB setup failed:', err);
      process.exit(1);
    });
}
