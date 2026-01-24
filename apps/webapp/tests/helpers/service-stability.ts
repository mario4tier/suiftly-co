/**
 * Service Stability Test Utilities
 *
 * Detects unexpected service restarts during E2E test execution.
 * Tests capture PIDs at start and verify they haven't changed at end.
 *
 * ## Why This Matters
 * - Systemd services can restart silently (e.g., OOM, crash, watchdog)
 * - Service restarts during tests cause intermittent failures
 * - Without PID verification, failures are misattributed to test flakiness
 *
 * ## Usage
 * ```typescript
 * import { ServiceStabilityChecker } from '../helpers/service-stability';
 *
 * test.describe('My Tests', () => {
 *   let stabilityChecker: ServiceStabilityChecker;
 *
 *   test.beforeEach(async ({ request }) => {
 *     stabilityChecker = new ServiceStabilityChecker(request);
 *     await stabilityChecker.captureInitialState();
 *   });
 *
 *   test.afterEach(async () => {
 *     // This throws if any service restarted during the test
 *     await stabilityChecker.verifyServicesStable();
 *   });
 *
 *   test('my test', async ({ page }) => {
 *     // If services restart during this test, afterEach will fail it
 *   });
 * });
 * ```
 *
 * ## Services Monitored
 * - API Server (localhost:22700)
 * - Global Manager (localhost:22600)
 * - Local Manager (localhost:22610)
 */

import type { APIRequestContext } from '@playwright/test';

const API_URL = 'http://localhost:22700';
const GM_URL = 'http://localhost:22600';
const LM_URL = 'http://localhost:22610';

export interface ProcessInfo {
  service: string;
  pid: number;
  uptime: number;
  startedAt: string;
}

export interface ServiceState {
  api?: ProcessInfo;
  gm?: ProcessInfo;
  lm?: ProcessInfo;
  capturedAt: string;
}

export interface StabilityCheckResult {
  stable: boolean;
  errors: string[];
  details: {
    service: string;
    initialPid: number;
    currentPid: number;
    restarted: boolean;
  }[];
}

/**
 * Fetch process info from a service's test endpoint
 * Returns null if service is unavailable (not an error - service may not be running)
 */
async function fetchProcessInfo(
  request: APIRequestContext,
  url: string,
  serviceName: string
): Promise<ProcessInfo | null> {
  try {
    const response = await request.get(`${url}/test/process-info`, {
      timeout: 5000,
    });

    if (!response.ok()) {
      console.warn(`[service-stability] ${serviceName} returned ${response.status()}`);
      return null;
    }

    return await response.json();
  } catch (error) {
    // Service not available - this is expected if service isn't running
    console.warn(`[service-stability] ${serviceName} not reachable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Service Stability Checker
 *
 * Captures service PIDs at test start and verifies they haven't changed at test end.
 * Detects service restarts that would cause intermittent test failures.
 */
export class ServiceStabilityChecker {
  private request: APIRequestContext;
  private initialState: ServiceState | null = null;
  private testName: string = '';

  constructor(request: APIRequestContext) {
    this.request = request;
  }

  /**
   * Set test name for better error messages
   */
  setTestName(name: string): void {
    this.testName = name;
  }

  /**
   * Capture initial service state (PIDs) at test start
   * Call this in beforeEach after any setup that might restart services
   */
  async captureInitialState(): Promise<ServiceState> {
    const [api, gm, lm] = await Promise.all([
      fetchProcessInfo(this.request, API_URL, 'API'),
      fetchProcessInfo(this.request, GM_URL, 'GM'),
      fetchProcessInfo(this.request, LM_URL, 'LM'),
    ]);

    this.initialState = {
      api: api ?? undefined,
      gm: gm ?? undefined,
      lm: lm ?? undefined,
      capturedAt: new Date().toISOString(),
    };

    const services = [
      api ? `API(pid=${api.pid})` : null,
      gm ? `GM(pid=${gm.pid})` : null,
      lm ? `LM(pid=${lm.pid})` : null,
    ].filter(Boolean);

    if (services.length > 0) {
      console.log(`[service-stability] Captured initial state: ${services.join(', ')}`);
    }

    return this.initialState;
  }

  /**
   * Verify services haven't restarted since initial capture
   * Call this in afterEach to detect service restarts during test
   *
   * @throws Error if any monitored service restarted (different PID)
   */
  async verifyServicesStable(): Promise<StabilityCheckResult> {
    if (!this.initialState) {
      throw new Error('[service-stability] Cannot verify: initial state not captured. Call captureInitialState() first.');
    }

    const [api, gm, lm] = await Promise.all([
      fetchProcessInfo(this.request, API_URL, 'API'),
      fetchProcessInfo(this.request, GM_URL, 'GM'),
      fetchProcessInfo(this.request, LM_URL, 'LM'),
    ]);

    const result: StabilityCheckResult = {
      stable: true,
      errors: [],
      details: [],
    };

    // Check each service that was running at start
    const checks: { name: string; initial?: ProcessInfo; current: ProcessInfo | null }[] = [
      { name: 'API', initial: this.initialState.api, current: api },
      { name: 'GM', initial: this.initialState.gm, current: gm },
      { name: 'LM', initial: this.initialState.lm, current: lm },
    ];

    for (const { name, initial, current } of checks) {
      if (!initial) {
        // Service wasn't running at start - skip
        continue;
      }

      if (!current) {
        // Service was running but is now unavailable
        result.stable = false;
        result.errors.push(
          `${name} service was running (pid=${initial.pid}) but is now unavailable`
        );
        result.details.push({
          service: name,
          initialPid: initial.pid,
          currentPid: 0,
          restarted: true,
        });
        continue;
      }

      const restarted = initial.pid !== current.pid;
      result.details.push({
        service: name,
        initialPid: initial.pid,
        currentPid: current.pid,
        restarted,
      });

      if (restarted) {
        result.stable = false;
        result.errors.push(
          `${name} service restarted during test: pid changed from ${initial.pid} to ${current.pid}` +
          ` (started at ${current.startedAt})`
        );
      }
    }

    // Throw if unstable - this fails the test in afterEach
    if (!result.stable) {
      const testInfo = this.testName ? ` [${this.testName}]` : '';
      throw new Error(
        `[service-stability] Services restarted during test${testInfo}:\n` +
        result.errors.map(e => `  - ${e}`).join('\n') +
        '\n\nThis indicates infrastructure instability. Test results are unreliable.'
      );
    }

    return result;
  }

  /**
   * Check if all expected services are available
   * Use this for pre-test health validation
   *
   * @param required - Services that must be running (default: ['api', 'gm'])
   * @throws Error if any required service is unavailable
   */
  async ensureServicesAvailable(required: ('api' | 'gm' | 'lm')[] = ['api', 'gm']): Promise<void> {
    const [api, gm, lm] = await Promise.all([
      required.includes('api') ? fetchProcessInfo(this.request, API_URL, 'API') : null,
      required.includes('gm') ? fetchProcessInfo(this.request, GM_URL, 'GM') : null,
      required.includes('lm') ? fetchProcessInfo(this.request, LM_URL, 'LM') : null,
    ]);

    const missing: string[] = [];
    if (required.includes('api') && !api) missing.push('API (localhost:22700)');
    if (required.includes('gm') && !gm) missing.push('GM (localhost:22600)');
    if (required.includes('lm') && !lm) missing.push('LM (localhost:22610)');

    if (missing.length > 0) {
      throw new Error(
        `[service-stability] Required services not available:\n` +
        missing.map(s => `  - ${s}`).join('\n') +
        '\n\nStart services with: cd ~/suiftly-co && ./scripts/dev/start-dev.sh'
      );
    }
  }

  /**
   * Get current service state without validation
   * Useful for debugging
   */
  async getCurrentState(): Promise<ServiceState> {
    const [api, gm, lm] = await Promise.all([
      fetchProcessInfo(this.request, API_URL, 'API'),
      fetchProcessInfo(this.request, GM_URL, 'GM'),
      fetchProcessInfo(this.request, LM_URL, 'LM'),
    ]);

    return {
      api: api ?? undefined,
      gm: gm ?? undefined,
      lm: lm ?? undefined,
      capturedAt: new Date().toISOString(),
    };
  }
}

/**
 * Standalone function to check service health
 * Use for quick checks without full stability tracking
 */
export async function checkServicesHealth(
  request: APIRequestContext
): Promise<{ available: string[]; unavailable: string[] }> {
  const [api, gm, lm] = await Promise.all([
    fetchProcessInfo(request, API_URL, 'API'),
    fetchProcessInfo(request, GM_URL, 'GM'),
    fetchProcessInfo(request, LM_URL, 'LM'),
  ]);

  const available: string[] = [];
  const unavailable: string[] = [];

  if (api) available.push(`API(pid=${api.pid})`);
  else unavailable.push('API(localhost:22700)');

  if (gm) available.push(`GM(pid=${gm.pid})`);
  else unavailable.push('GM(localhost:22600)');

  if (lm) available.push(`LM(pid=${lm.pid})`);
  else unavailable.push('LM(localhost:22610)');

  return { available, unavailable };
}
