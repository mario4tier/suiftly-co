/**
 * HTTP test utilities
 *
 * Helpers for making HTTP calls in API tests.
 * These simulate real client behavior by using fetch instead of direct function calls.
 */

const API_BASE = 'http://localhost:22700'; // See ~/mhaxbe/PORT_MAP.md

/**
 * Make a tRPC query (GET) request
 *
 * @param path - The tRPC procedure path (e.g., 'services.subscribe')
 * @param input - The input parameters
 * @param accessToken - JWT access token from login()
 */
export async function trpcQuery<T>(
  path: string,
  input: any,
  accessToken?: string
): Promise<{ result?: { data: T }; error?: any }> {
  const url = new URL(`${API_BASE}/i/api/${path}`);
  url.searchParams.set('input', JSON.stringify(input));

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
  });

  const data = await response.json() as { result?: { data: T }; error?: any };
  return data;
}

/**
 * Make a tRPC mutation (POST) request
 *
 * @param path - The tRPC procedure path (e.g., 'services.subscribe')
 * @param input - The input parameters
 * @param accessToken - JWT access token from login()
 */
export async function trpcMutation<T>(
  path: string,
  input: any,
  accessToken?: string
): Promise<{ result?: { data: T }; error?: any }> {
  const response = await fetch(`${API_BASE}/i/api/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(input),
  });

  const data = await response.json() as { result?: { data: T }; error?: any };
  return data;
}

/**
 * Make a REST API call
 */
export async function restCall<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: any,
  cookie?: string
): Promise<{ success: boolean; data?: T; error?: string; status: number }> {
  let response: Response;
  try {
    const headers: Record<string, string> = {};
    if (body) {
      headers['Content-Type'] = 'application/json';
    }
    if (cookie) {
      headers['Cookie'] = cookie;
    }
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Network error (server not reachable)
    return {
      success: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
      status: 0,
    };
  }

  const status = response.status;

  try {
    const data = await response.json() as T | undefined;
    if (!response.ok) {
      // Extract error from response body if present
      const errorMsg = (data as any)?.error || (data as any)?.message || `HTTP ${status}`;
      return { success: false, data, error: errorMsg, status };
    }
    return { success: true, data, status };
  } catch {
    const text = await response.text();
    return { success: response.ok, error: text || `HTTP ${status}`, status };
  }
}

// ============================================================================
// Test-Only Endpoints (for controlling test state)
// ============================================================================

const GM_BASE = 'http://localhost:22600'; // Global Manager

/**
 * Set mock clock time via Global Manager
 *
 * GM is the single source of truth for mock time:
 * - GM writes mock time to test_kv table
 * - All processes (API, GM) sync from test_kv before billing operations
 */
export async function setClockTime(time: string | Date): Promise<void> {
  const timeStr = typeof time === 'string' ? time : time.toISOString();

  const response = await fetch(`${GM_BASE}/api/test/clock/mock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ time: timeStr }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to set clock time via GM: ${response.status} ${text}`);
  }
}

/**
 * Advance mock clock via Global Manager
 */
export async function advanceClock(duration: {
  days?: number;
  hours?: number;
  minutes?: number;
}): Promise<void> {
  const response = await fetch(`${GM_BASE}/api/test/clock/advance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(duration),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to advance clock via GM: ${response.status} ${text}`);
  }
}

/**
 * Reset clock to real time via Global Manager
 */
export async function resetClock(): Promise<void> {
  const response = await fetch(`${GM_BASE}/api/test/clock/real`, {
    method: 'POST',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to reset clock via GM: ${response.status} ${text}`);
  }
}

/**
 * Get current clock status from Global Manager
 */
export async function getClockStatus(): Promise<{
  type: 'real' | 'mock';
  currentTime: string;
}> {
  const response = await fetch(`${GM_BASE}/api/test/clock`);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get clock status from GM: ${response.status} ${text}`);
  }

  return response.json();
}

/**
 * Run the periodic billing job
 */
export async function runPeriodicBillingJob(customerId?: number): Promise<{
  success: boolean;
  result: any;
}> {
  const result = await restCall<any>('POST', '/test/billing/run-periodic-job', { customerId });
  if (!result.success || !result.data) {
    throw new Error(`Failed to run periodic billing job: ${result.error}`);
  }
  return result.data;
}

/**
 * Reconcile pending payments for a customer
 * This simulates what GM does after a deposit - processes any pending subscription charges
 */
export async function reconcilePendingPayments(customerId: number): Promise<{
  success: boolean;
  result: any;
}> {
  const result = await restCall<any>('POST', '/test/billing/reconcile', { customerId });
  if (!result.success || !result.data) {
    throw new Error(`Failed to reconcile payments: ${result.error}`);
  }
  return result.data;
}

/**
 * Reset test data (delete customer and related data)
 */
export async function resetTestData(walletAddress?: string): Promise<void> {
  const result = await restCall('POST', '/test/data/reset', { walletAddress });
  if (!result.success) {
    throw new Error(`Failed to reset test data: ${result.error}`);
  }
}

/**
 * Full test environment clean-slate via sudob
 * Stops services, deletes vault files, truncates DB, starts services.
 * All destructive operations live in sudob (which never runs in production).
 */
export async function truncateAllTables(): Promise<void> {
  const { PORT } = await import('@suiftly/shared/constants');
  const response = await fetch(`http://localhost:${PORT.SUDOB}/api/test/reset-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(`Failed to reset-all via sudob: ${await response.text()}`);
  }
}

/**
 * Subscribe to a service and enable it via API
 * This is the proper API-based flow for setting up a paid, enabled service.
 *
 * This helper validates its own actions:
 * - Verifies payment succeeded (paymentPending: false)
 * - Verifies service starts in DISABLED state (business rule: disabled by default)
 * - Verifies service was enabled after toggle (isUserEnabled: true)
 *
 * @param serviceType - The service type (e.g., 'seal')
 * @param tier - The tier (e.g., 'starter', 'pro', 'enterprise')
 * @param accessToken - JWT access token from login()
 * @returns The subscribe result data
 * @throws Error if subscribe fails, payment is pending, service doesn't start disabled, or enable fails
 */
export async function subscribeAndEnable(
  serviceType: string,
  tier: string,
  accessToken: string
): Promise<{ paymentPending: boolean; tier: string; [key: string]: any }> {
  // Subscribe to service
  const subscribeResult = await trpcMutation<any>(
    'services.subscribe',
    { serviceType, tier },
    accessToken
  );

  if (subscribeResult.error) {
    throw new Error(`Subscribe failed: ${JSON.stringify(subscribeResult.error)}`);
  }

  const data = subscribeResult.result?.data;
  if (!data) {
    throw new Error('Subscribe returned no data');
  }

  // Validate: Subscription should be for the requested tier
  if (data.tier !== tier) {
    throw new Error(`Subscribe returned wrong tier: expected ${tier}, got ${data.tier}`);
  }

  // Validate: Payment should have succeeded (sufficient balance expected)
  if (data.paymentPending) {
    throw new Error(`Subscribe payment pending - ensure sufficient balance before calling subscribeAndEnable`);
  }

  // Validate: Service should start in DISABLED state (business rule)
  // New subscriptions must be manually enabled by the user
  if (data.state !== 'disabled') {
    throw new Error(`Subscribe should return service in disabled state, got: ${data.state}`);
  }
  if (data.isUserEnabled !== false) {
    throw new Error(`Subscribe should return isUserEnabled=false, got: ${data.isUserEnabled}`);
  }

  // Enable the service
  const toggleResult = await trpcMutation<any>(
    'services.toggleService',
    { serviceType, enabled: true },
    accessToken
  );

  if (toggleResult.error) {
    throw new Error(`Toggle service failed: ${JSON.stringify(toggleResult.error)}`);
  }

  // Validate: Service should now be enabled
  const toggleData = toggleResult.result?.data;
  if (!toggleData?.isUserEnabled) {
    throw new Error(`Toggle service did not enable: isUserEnabled=${toggleData?.isUserEnabled}`);
  }

  return data;
}

/**
 * Ensure test wallet has specific balance
 */
export async function ensureTestBalance(
  targetBalanceUsd: number,
  options?: { walletAddress?: string; spendingLimitUsd?: number }
): Promise<void> {
  const walletAddress = options?.walletAddress || '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  // First check current balance
  const balanceResult = await restCall<any>('GET', `/test/wallet/balance?walletAddress=${walletAddress}`);

  if (!balanceResult.data?.found) {
    // Create account with deposit
    const depositResult = await restCall('POST', '/test/wallet/deposit', {
      walletAddress,
      amountUsd: targetBalanceUsd,
      initialSpendingLimitUsd: options?.spendingLimitUsd || 250,
    });
    if (!depositResult.success) {
      throw new Error(`Failed to create test account: ${depositResult.error}`);
    }
    return;
  }

  const currentBalance = balanceResult.data.balanceUsd;
  const diff = targetBalanceUsd - currentBalance;

  if (Math.abs(diff) < 0.01) {
    return; // Already at target
  }

  if (diff > 0) {
    const depositResult = await restCall('POST', '/test/wallet/deposit', {
      walletAddress,
      amountUsd: diff,
    });
    if (!depositResult.success) {
      throw new Error(`Failed to deposit: ${depositResult.error}`);
    }
  } else {
    const withdrawResult = await restCall('POST', '/test/wallet/withdraw', {
      walletAddress,
      amountUsd: Math.abs(diff),
    });
    if (!withdrawResult.success) {
      throw new Error(`Failed to withdraw: ${withdrawResult.error}`);
    }
  }
}
