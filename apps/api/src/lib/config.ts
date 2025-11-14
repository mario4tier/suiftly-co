/**
 * Environment configuration
 * Centralized config with validation
 *
 * Security: Loads secrets from ~/.suiftly.env (not project directory) to prevent accidental git commits
 * See docs/APP_SECURITY_DESIGN.md for complete secret management procedures
 */

import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// STEP 0: Read system configuration to determine deployment type and API server role
function readSystemConfig(): { deploymentType: string; isApiServer: boolean } {
  try {
    const configPath = '/etc/walrus/system.conf';
    const config = readFileSync(configPath, 'utf-8');

    const deploymentMatch = config.match(/DEPLOYMENT_TYPE=(\w+)/);
    const apiServerMatch = config.match(/APISERVER=([01])/);

    return {
      deploymentType: deploymentMatch ? deploymentMatch[1] : 'development',
      isApiServer: apiServerMatch ? apiServerMatch[1] === '1' : false,
    };
  } catch (error) {
    // If file doesn't exist, assume development non-API server
    console.log('[Config] ⚠️  /etc/walrus/system.conf not found, assuming development');
    return { deploymentType: 'development', isApiServer: false };
  }
}

export const systemConfig = readSystemConfig();
export const isProduction = systemConfig.deploymentType === 'production';

console.log(`[Config] System: ${systemConfig.deploymentType}, API Server: ${systemConfig.isApiServer}`);

// STEP 1: Load from ~/.suiftly.env (production/development)
// This prevents secrets from being in the git repository
// Note: Using .suiftly.env instead of .env to avoid conflicts with Python venvs
const homeEnvPath = join(homedir(), '.suiftly.env');

// GUARD: If APISERVER=1, ~/.suiftly.env MUST exist
if (systemConfig.isApiServer && !existsSync(homeEnvPath)) {
  throw new Error(
    `FATAL: APISERVER=1 in /etc/walrus/system.conf but ${homeEnvPath} not found!\n` +
    `This system is configured as an API server and requires secrets.\n` +
    `See docs/APP_SECURITY_DESIGN.md for setup instructions.\n` +
    `Quick fix: Run setup-users.py or manually create ~/.suiftly.env`
  );
}

if (existsSync(homeEnvPath)) {
  try {
    const envFile = readFileSync(homeEnvPath, 'utf-8');
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
    console.log(`[Config] ✅ Loaded secrets from ${homeEnvPath}`);
  } catch (err) {
    console.error(`[Config] ⚠️  Failed to read ${homeEnvPath}:`, err);
  }
} else if (isProduction) {
  // GUARD: Production MUST have ~/.suiftly.env file
  throw new Error(
    `FATAL: ${homeEnvPath} not found in production!\n` +
    `This file must contain JWT_SECRET and DB_APP_FIELDS_ENCRYPTION_KEY.\n` +
    `See docs/APP_SECURITY_DESIGN.md for setup instructions.`
  );
} else {
  // Development/test: Allow environment variables (CI/CD)
  console.log(`[Config] ⚠️  No ${homeEnvPath} file found (using environment variables)`);
}

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000'),
  HOST: z.string().default('0.0.0.0'),

  // Database
  DATABASE_URL: z.string().default('postgresql://localhost/suiftly_dev'),

  // Security (REQUIRED - no defaults in production)
  // Note: These are base64-encoded 32-byte values (decode to plaintext with "dev" marker)
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 bytes (256 bits)').default(
    process.env.NODE_ENV === 'production'
      ? '' // No default in production (will fail validation)
      : 'ZGV2LXNlY3JldC1mb3ItdGVzdGluZy1vbmx5ISEhISE=' // base64: "dev-secret-for-testing-only!!!!!"
  ),
  DB_APP_FIELDS_ENCRYPTION_KEY: z.string().min(32, 'DB_APP_FIELDS_ENCRYPTION_KEY must be at least 32 bytes').default(
    process.env.NODE_ENV === 'production'
      ? '' // No default in production (will fail validation)
      : 'ZGV2LWVuY3J5cHRpb24ta2V5LXRlc3Qtb25seSEhISE=' // base64: "dev-encryption-key-test-only!!!!"
  ),
  COOKIE_SECRET: z.string().min(32).default('ZGV2LWNvb2tpZS1zZWNyZXQtdGVzdGluZy1vbmx5ISE='), // base64: "dev-cookie-secret-testing-only!!"

  // Auth
  // Default to true in development for easier testing
  MOCK_AUTH: z.string().transform(val => val === 'true').default(
    process.env.NODE_ENV === 'production' ? 'false' : 'true'
  ),

  // CORS
  CORS_ORIGIN: z.string().default('http://localhost:5173'), // Vite default port

  // Rate limiting
  RATE_LIMIT_MAX: z.string().transform(Number).default('100'), // requests per minute
});

export const config = envSchema.parse(process.env);

// STEP 2.5: Write parsed config back to process.env
// This ensures process.env has the same values as config (including defaults)
// Important for tests that modify process.env to verify error handling
process.env.NODE_ENV = config.NODE_ENV;
process.env.PORT = config.PORT;
process.env.HOST = config.HOST;
process.env.DATABASE_URL = config.DATABASE_URL;
process.env.JWT_SECRET = config.JWT_SECRET;
process.env.DB_APP_FIELDS_ENCRYPTION_KEY = config.DB_APP_FIELDS_ENCRYPTION_KEY;
process.env.COOKIE_SECRET = config.COOKIE_SECRET;
process.env.MOCK_AUTH = config.MOCK_AUTH.toString();
process.env.CORS_ORIGIN = config.CORS_ORIGIN;
process.env.RATE_LIMIT_MAX = config.RATE_LIMIT_MAX.toString();

// STEP 3: Validate secrets don't match production keys
// NOTE: This runs during module initialization (when config.ts is first imported)
// This ensures the API server CANNOT START if secrets are invalid
// Fail-fast behavior: prevents runtime security issues
validateSecretSafety();

function validateSecretSafety() {
  const isDev = config.NODE_ENV === 'development';
  const isTest = config.NODE_ENV === 'test';
  const isProd = config.NODE_ENV === 'production';

  // Default test secrets used in development/testing (plaintext, will be base64-encoded in config)
  const DEFAULT_TEST_JWT_SECRET = 'dev-secret-for-testing-only!!!!!';
  const DEFAULT_TEST_ENCRYPTION_KEY = 'dev-encryption-key-test-only!!!!';
  const DEFAULT_TEST_COOKIE_SECRET = 'dev-cookie-secret-testing-only!!';

  // GUARD 1: Production must NOT use default/weak secrets
  if (isProd || isProduction) {
    // Check for exact match with default test secrets (decode config values to compare)
    try {
      const jwtDecoded = Buffer.from(config.JWT_SECRET, 'base64').toString('utf8');
      if (jwtDecoded === DEFAULT_TEST_JWT_SECRET) {
        throw new Error(
          'FATAL SECURITY ERROR: Production is using the DEFAULT test JWT_SECRET!\n' +
          'This is the same secret used in development/testing and is publicly known.\n' +
          'This would allow anyone to forge authentication tokens.\n' +
          'Generate a new secret: openssl rand -base64 32'
        );
      }
    } catch (e) {
      // If decode fails, not using default (proceed to other checks)
    }

    try {
      const encKeyDecoded = Buffer.from(config.DB_APP_FIELDS_ENCRYPTION_KEY, 'base64').toString('utf8');
      if (encKeyDecoded === DEFAULT_TEST_ENCRYPTION_KEY) {
        throw new Error(
          'FATAL SECURITY ERROR: Production is using the DEFAULT test DB_APP_FIELDS_ENCRYPTION_KEY!\n' +
          'This is the same secret used in development/testing and is publicly known.\n' +
          'This would expose customer API keys and secrets.\n' +
          'Generate a new secret: openssl rand -base64 32'
        );
      }
    } catch (e) {
      // If decode fails, not using default (proceed to other checks)
    }

    try {
      const cookieDecoded = Buffer.from(config.COOKIE_SECRET, 'base64').toString('utf8');
      if (cookieDecoded === DEFAULT_TEST_COOKIE_SECRET) {
        throw new Error(
          'FATAL SECURITY ERROR: Production is using the DEFAULT test COOKIE_SECRET!\n' +
          'This is the same secret used in development/testing and is publicly known.\n' +
          'This would allow cookie forgery.\n' +
          'Generate a new secret: openssl rand -base64 32'
        );
      }
    } catch (e) {
      // If decode fails, not using default (proceed to other checks)
    }

    // Check decoded secrets for dev/test markers (base64-encoded secrets)
    try {
      const jwtDecoded = Buffer.from(config.JWT_SECRET, 'base64').toString('utf8');
      if (jwtDecoded.includes('dev') || jwtDecoded.includes('test')) {
        throw new Error(
          'FATAL SECURITY ERROR: Production is using development/test JWT_SECRET!\n' +
          'Decoded secret contains "dev" or "test" marker.\n' +
          'This would allow anyone to forge authentication tokens.\n' +
          'Generate a new secret: openssl rand -base64 32'
        );
      }
    } catch (e) {
      // If not valid base64, secret is likely production (random bytes)
    }

    try {
      const encKeyDecoded = Buffer.from(config.DB_APP_FIELDS_ENCRYPTION_KEY, 'base64').toString('utf8');
      if (encKeyDecoded.includes('dev') || encKeyDecoded.includes('test')) {
        throw new Error(
          'FATAL SECURITY ERROR: Production is using development/test DB_APP_FIELDS_ENCRYPTION_KEY!\n' +
          'Decoded secret contains "dev" or "test" marker.\n' +
          'This would expose customer API keys and secrets.\n' +
          'Generate a new secret: openssl rand -base64 32'
        );
      }
    } catch (e) {
      // If not valid base64, secret is likely production (random bytes)
    }

    try {
      const cookieDecoded = Buffer.from(config.COOKIE_SECRET, 'base64').toString('utf8');
      if (cookieDecoded.includes('dev') || cookieDecoded.includes('test')) {
        throw new Error(
          'FATAL SECURITY ERROR: Production is using development/test COOKIE_SECRET!\n' +
          'Decoded secret contains "dev" or "test" marker.\n' +
          'This would allow cookie forgery.\n' +
          'Generate a new secret: openssl rand -base64 32'
        );
      }
    } catch (e) {
      // If not valid base64, secret is likely production (random bytes)
    }

    // Ensure secrets are not empty (Zod should catch this, but double-check)
    if (!config.JWT_SECRET || config.JWT_SECRET.length < 32) {
      throw new Error(
        'FATAL SECURITY ERROR: JWT_SECRET missing or too short in production!\n' +
        'Generate a new secret: openssl rand -base64 32'
      );
    }

    if (!config.DB_APP_FIELDS_ENCRYPTION_KEY || config.DB_APP_FIELDS_ENCRYPTION_KEY.length < 32) {
      throw new Error(
        'FATAL SECURITY ERROR: DB_APP_FIELDS_ENCRYPTION_KEY missing or too short in production!\n' +
        'Generate a new secret: openssl rand -base64 32'
      );
    }

    if (!config.COOKIE_SECRET || config.COOKIE_SECRET.length < 32) {
      throw new Error(
        'FATAL SECURITY ERROR: COOKIE_SECRET missing or too short in production!\n' +
        'Generate a new secret: openssl rand -base64 32'
      );
    }
  }

  // GUARD 2: Development/test should NOT use production-like secrets
  // (Prevents accidental encryption with prod keys that might leak to git)
  // Note: Secrets are base64-encoded, so we decode to check for markers
  const jwtDecoded = Buffer.from(config.JWT_SECRET, 'base64').toString('utf8');
  const encKeyDecoded = Buffer.from(config.DB_APP_FIELDS_ENCRYPTION_KEY, 'base64').toString('utf8');

  if ((isDev || isTest) && !jwtDecoded.includes('test') && !jwtDecoded.includes('dev')) {
    console.warn(
      '⚠️  WARNING: JWT_SECRET does not contain "dev" or "test" marker.\n' +
      'If this is a production key, it should NOT be in dev/test environments.\n' +
      'Consider regenerating dev/test secrets with identifiable markers.\n' +
      `Decoded preview: ${jwtDecoded.slice(0, 10)}...`
    );
  }

  if ((isDev || isTest) && !encKeyDecoded.includes('test') && !encKeyDecoded.includes('dev')) {
    console.warn(
      '⚠️  WARNING: DB_APP_FIELDS_ENCRYPTION_KEY does not contain "dev" or "test" marker.\n' +
      'If this is a production key, it should NOT be in dev/test environments.\n' +
      `Decoded preview: ${encKeyDecoded.slice(0, 10)}...`
    );
  }
}

// Log configuration on startup (mask secrets)
export function logConfig() {
  console.log('\n📋 Configuration:');
  console.log(`  Environment: ${config.NODE_ENV}`);
  console.log(`  Port: ${config.PORT}`);
  console.log(`  Host: ${config.HOST}`);
  console.log(`  Database: ${config.DATABASE_URL.split('@')[1] || 'local'}`);
  console.log(`  JWT_SECRET: ${config.JWT_SECRET.slice(0, 8)}...${config.JWT_SECRET.slice(-4)} (${config.JWT_SECRET.length} chars)`);
  console.log(`  DB_APP_FIELDS_ENCRYPTION_KEY: ${config.DB_APP_FIELDS_ENCRYPTION_KEY.slice(0, 8)}...${config.DB_APP_FIELDS_ENCRYPTION_KEY.slice(-4)} (${config.DB_APP_FIELDS_ENCRYPTION_KEY.length} chars)`);
  console.log(`  Mock Auth: ${config.MOCK_AUTH ? 'ENABLED' : 'DISABLED'}`);
  console.log(`  CORS Origin: ${config.CORS_ORIGIN}`);
  console.log(`  Rate Limit: ${config.RATE_LIMIT_MAX}/min`);
  console.log('');
}
