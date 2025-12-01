import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load .env file if it exists (needed when running tsx directly)
// Look for .env in current dir and parent dirs (monorepo support)
try {
  let currentDir = process.cwd();

  // Try finding .env file by walking up the directory tree
  while (currentDir !== '/' && currentDir.length > 1) {
    try {
      const envPath = join(currentDir, '.env');
      const envFile = readFileSync(envPath, 'utf-8');

      envFile.split('\n').forEach(line => {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) {
          const key = match[1].trim();
          const value = match[2].trim();
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      });
      break; // Found and loaded .env file
    } catch {
      // Try parent directory
      currentDir = join(currentDir, '..');
    }
  }
} catch (err) {
  // .env file not found, that's okay
}

const connectionString = process.env.DATABASE_URL || 'postgresql://localhost/suiftly_dev';

const pool = new Pool({
  connectionString,
});

export const db = drizzle(pool, { schema });

// Export database type for use in billing modules
// This preserves schema types when passing transactions around
export type Database = typeof db;

// Transaction type - used in billing modules for functions that can work
// with either the main db connection or a transaction
// Uses Omit to remove $client which isn't available on transactions
export type DatabaseOrTransaction = Omit<Database, '$client'>;
