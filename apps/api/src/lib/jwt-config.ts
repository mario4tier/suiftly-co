/**
 * JWT Configuration with Production Safety Guards
 * Enables fast testing with short expiry times while preventing accidents in production
 */

export interface JWTConfig {
  accessTokenExpiry: string;
  refreshTokenExpiry: string;
}

/**
 * Parse expiry string (e.g., '15m', '30d', '2s') to seconds
 */
function parseExpiryToSeconds(expiry: string): number {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid expiry format: ${expiry}. Use format like '15m', '30d', '2s'`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  };

  return value * multipliers[unit];
}

/**
 * Convert expiry string to milliseconds (for database timestamps)
 * Examples: "2s" -> 2000, "15m" -> 900000, "30d" -> 2592000000
 */
export function parseExpiryToMs(expiry: string): number {
  return parseExpiryToSeconds(expiry) * 1000;
}

/**
 * Validate that JWT config is safe for production
 * Throws error if expiry times are dangerously short
 */
function validateProductionSafety(config: JWTConfig): void {
  const MIN_ACCESS_TOKEN_SECONDS = 60; // Never less than 1 minute
  const MIN_REFRESH_TOKEN_SECONDS = 3600; // Never less than 1 hour

  const accessSeconds = parseExpiryToSeconds(config.accessTokenExpiry);
  const refreshSeconds = parseExpiryToSeconds(config.refreshTokenExpiry);

  if (accessSeconds < MIN_ACCESS_TOKEN_SECONDS) {
    throw new Error(
      `FATAL SECURITY ERROR: Access token expiry (${accessSeconds}s) is too short for production!\n` +
        `Minimum allowed: ${MIN_ACCESS_TOKEN_SECONDS}s (1 minute)\n` +
        `Current setting: ${config.accessTokenExpiry}\n` +
        `This would force users to re-authenticate constantly.`
    );
  }

  if (refreshSeconds < MIN_REFRESH_TOKEN_SECONDS) {
    throw new Error(
      `FATAL SECURITY ERROR: Refresh token expiry (${refreshSeconds}s) is too short for production!\n` +
        `Minimum allowed: ${MIN_REFRESH_TOKEN_SECONDS}s (1 hour)\n` +
        `Current setting: ${config.refreshTokenExpiry}\n` +
        `This would force users to re-authenticate constantly.`
    );
  }
}

/**
 * Get production JWT configuration (safe defaults)
 */
function getProductionJWTConfig(): JWTConfig {
  const config: JWTConfig = {
    accessTokenExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
    refreshTokenExpiry: process.env.JWT_REFRESH_EXPIRY || '30d',
  };

  // GUARD: Validate minimum expiry times in production
  validateProductionSafety(config);

  return config;
}

/**
 * Get test JWT configuration (short expiry for rapid testing)
 * REQUIRES EXPLICIT OPT-IN WITH MULTIPLE GUARDS
 */
function getTestJWTConfig(): JWTConfig {
  // GUARD 1: Only allow in test/development environments
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'FATAL: Cannot use test JWT config in production!\n' +
        'This would cause all tokens to expire in seconds.'
    );
  }

  // GUARD 2: Require explicit opt-in
  if (process.env.ENABLE_SHORT_JWT_EXPIRY !== 'true') {
    throw new Error(
      'Test JWT config requires explicit opt-in.\n' +
        'Set ENABLE_SHORT_JWT_EXPIRY=true in your test environment.'
    );
  }

  // GUARD 3: Require test/dev secret (safety check)
  const secret = process.env.JWT_SECRET || '';
  if (!secret.includes('TEST') && !secret.includes('DEV')) {
    throw new Error(
      'JWT_SECRET must contain "TEST" or "DEV" substring for short expiry.\n' +
        'This prevents accidentally using test config with production secrets.\n' +
        `Current secret preview: ${secret.slice(0, 10)}...`
    );
  }

  console.log('[JWT] ⚠️  Using TEST config with SHORT token expiry (access: 2s, refresh: 10s)');

  return {
    accessTokenExpiry: '2s', // 2 seconds for quick testing
    refreshTokenExpiry: '10s', // 10 seconds for refresh testing
  };
}

/**
 * Get JWT configuration (auto-selects production or test config)
 * SAFE DEFAULT: Always returns production config unless ALL test conditions are met
 */
export function getJWTConfig(): JWTConfig {
  // Check if all test conditions are met
  const isTestEnv = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
  const shortExpiryEnabled = process.env.ENABLE_SHORT_JWT_EXPIRY === 'true';
  const hasTestSecret =
    (process.env.JWT_SECRET || '').includes('TEST') ||
    (process.env.JWT_SECRET || '').includes('DEV');

  if (isTestEnv && shortExpiryEnabled && hasTestSecret) {
    return getTestJWTConfig();
  }

  // Safe default: production config
  return getProductionJWTConfig();
}

/**
 * Get human-readable summary of current JWT config (for logging)
 */
export function getJWTConfigSummary(): string {
  const config = getJWTConfig();
  const accessSeconds = parseExpiryToSeconds(config.accessTokenExpiry);
  const refreshSeconds = parseExpiryToSeconds(config.refreshTokenExpiry);

  return `Access: ${config.accessTokenExpiry} (${accessSeconds}s), Refresh: ${config.refreshTokenExpiry} (${refreshSeconds}s)`;
}
