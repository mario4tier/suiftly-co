/**
 * Runtime JWT Configuration Manager
 * Allows tests to dynamically change JWT expiry without restarting the server
 */

import { JWTConfig } from './jwt-config.js';

/**
 * Runtime JWT config override (for testing only)
 * When null, uses default config from jwt-config.ts
 */
let runtimeOverride: JWTConfig | null = null;

/**
 * Set runtime JWT config (for testing)
 */
export function setRuntimeJWTConfig(config: JWTConfig | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Cannot set runtime JWT config in production!');
  }
  runtimeOverride = config;
  if (config) {
    console.log(`[JWT] Runtime override set: access=${config.accessTokenExpiry}, refresh=${config.refreshTokenExpiry}`);
  } else {
    console.log('[JWT] Runtime override cleared, using default config');
  }
}

/**
 * Get current runtime JWT config (or null if using default)
 */
export function getRuntimeJWTConfig(): JWTConfig | null {
  return runtimeOverride;
}

/**
 * Check if runtime override is active
 */
export function hasRuntimeJWTOverride(): boolean {
  return runtimeOverride !== null;
}

/**
 * Clear runtime JWT config (restore defaults)
 */
export function clearRuntimeJWTConfig(): void {
  setRuntimeJWTConfig(null);
}
