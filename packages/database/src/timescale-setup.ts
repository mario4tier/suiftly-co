import { sql } from 'drizzle-orm';
import { db } from './db';

/**
 * Configure TimescaleDB hypertable for haproxy_raw_logs.
 * Run this AFTER creating the schema with drizzle-kit push.
 *
 * Based on walrus HAPROXY_LOGS.md specification:
 * - 1-hour chunks for faster pruning
 * - 6-hour compression policy
 * - 2-day retention (raw logs)
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

  // Add retention policy (auto-delete raw data older than 2 days)
  await db.execute(sql`
    SELECT add_retention_policy('haproxy_raw_logs', INTERVAL '2 days', if_not_exists => TRUE);
  `);
  console.log('✓ Added retention policy (2 days)');

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
