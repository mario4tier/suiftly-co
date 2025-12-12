/**
 * Local Manager (LM) Configuration
 *
 * Hard-coded LM endpoints for MVP.
 * In development, only local LM is configured.
 * In production, multiple LMs across regions.
 */

export interface LMEndpoint {
  id: string;
  name: string;
  host: string;
  region?: string;
}

/**
 * Get LM endpoints based on environment
 */
export function getLMEndpoints(): LMEndpoint[] {
  if (process.env.NODE_ENV === 'production') {
    // Production: Multiple LMs across regions
    // TODO: Configure actual production LM endpoints
    return [
      { id: 'lm-us-east-1', name: 'US East', host: 'http://lm-east.internal:22610', region: 'us-east-1' },
      { id: 'lm-us-west-1', name: 'US West', host: 'http://lm-west.internal:22610', region: 'us-west-1' },
    ];
  }

  // Development: Local LM only
  return [
    { id: 'lm-local', name: 'Local LM', host: 'http://localhost:22610', region: 'local' },
  ];
}

/**
 * Default timeout for LM health checks (ms)
 */
export const LM_HEALTH_CHECK_TIMEOUT = 5000;

/**
 * Interval for polling LM status (ms)
 * Default: 15 seconds
 */
export const LM_POLL_INTERVAL = 15_000;
