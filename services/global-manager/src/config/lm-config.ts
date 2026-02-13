/**
 * Local Manager (LM) Configuration
 *
 * Reads deployment type from /etc/mhaxbe/system.conf (DEPLOYMENT_TYPE).
 * - test: Local LM only (localhost:22610)
 * - production: Multiple LMs across regions
 */

import { readFileSync } from 'fs';

export interface LMEndpoint {
  id: string;
  name: string;
  host: string;
  region?: string;
}

// Cache system.conf values
let systemConfig: Record<string, string> | null = null;

/**
 * Read and parse /etc/mhaxbe/system.conf
 */
function getSystemConfig(): Record<string, string> {
  if (systemConfig !== null) {
    return systemConfig;
  }

  systemConfig = {};
  try {
    const content = readFileSync('/etc/mhaxbe/system.conf', 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          systemConfig[key.trim()] = valueParts.join('=').trim();
        }
      }
    }
  } catch (e) {
    console.warn('[LM-CONFIG] Could not read /etc/mhaxbe/system.conf, assuming test deployment');
  }

  return systemConfig;
}

/**
 * Get LM endpoints based on deployment type from system.conf
 */
export function getLMEndpoints(): LMEndpoint[] {
  const config = getSystemConfig();
  if (config.DEPLOYMENT_TYPE !== 'production') {
    // Test/dev deployment: Local LM only
    return [
      { id: 'lm-local', name: 'Local LM', host: 'http://localhost:22610', region: 'local' },
    ];
  }

  // Production: Multiple LMs across regions
  // TODO: Configure actual production LM endpoints
  return [
    { id: 'lm-us-east-1', name: 'US East', host: 'http://lm-east.internal:22610', region: 'us-east-1' },
    { id: 'lm-us-west-1', name: 'US West', host: 'http://lm-west.internal:22610', region: 'us-west-1' },
  ];
}

/**
 * Check if this is a test/development deployment (not production)
 * Used to enable test endpoints, mock clock, etc.
 */
export function isTestDeployment(): boolean {
  const config = getSystemConfig();
  return config.DEPLOYMENT_TYPE !== 'production';
}

/**
 * Default timeout for LM health checks (ms)
 */
export const LM_HEALTH_CHECK_TIMEOUT = 5000;
