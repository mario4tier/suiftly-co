/**
 * Environment configuration
 * Centralized config with validation
 */

import { z } from 'zod';

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000'),
  HOST: z.string().default('0.0.0.0'),

  // Database
  DATABASE_URL: z.string().default('postgresql://localhost/suiftly_dev'),

  // Security
  JWT_SECRET: z.string().min(32).default('dev-secret-change-in-production-MUST-BE-32-CHARS-MIN'),
  COOKIE_SECRET: z.string().min(32).default('dev-cookie-secret-change-in-production-32-CHARS'),

  // Auth
  MOCK_AUTH: z.string().transform(val => val === 'true').default('false'),

  // CORS
  CORS_ORIGIN: z.string().default('http://localhost:5173'), // Vite default port

  // Rate limiting
  RATE_LIMIT_MAX: z.string().transform(Number).default('100'), // requests per minute
});

export const config = envSchema.parse(process.env);

// Log configuration on startup (mask secrets)
export function logConfig() {
  console.log('\n📋 Configuration:');
  console.log(`  Environment: ${config.NODE_ENV}`);
  console.log(`  Port: ${config.PORT}`);
  console.log(`  Host: ${config.HOST}`);
  console.log(`  Database: ${config.DATABASE_URL.split('@')[1] || 'local'}`);
  console.log(`  Mock Auth: ${config.MOCK_AUTH ? 'ENABLED' : 'DISABLED'}`);
  console.log(`  CORS Origin: ${config.CORS_ORIGIN}`);
  console.log(`  Rate Limit: ${config.RATE_LIMIT_MAX}/min`);
  console.log('');
}
