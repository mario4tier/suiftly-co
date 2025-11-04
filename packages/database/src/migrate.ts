/**
 * Database migration runner
 * Applies pending SQL migrations from migrations/ folder
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const { Pool } = pg;

async function runMigrations() {
  const connectionString = process.env.DATABASE_URL || 'postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev';

  console.log('🔄 Running database migrations...');
  console.log(`📍 Database: ${connectionString.split('@')[1]}`);

  const pool = new Pool({
    connectionString,
  });

  const db = drizzle(pool);

  try {
    await migrate(db, { migrationsFolder: './migrations' });
    console.log('✅ Migrations completed successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();
