/**
 * HTTP test utilities
 *
 * Helpers for making HTTP calls in API tests.
 * These simulate real client behavior by using fetch instead of direct function calls.
 */

const API_BASE = 'http://localhost:3000';

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

/**
 * Set mock clock time
 */
export async function setClockTime(time: string | Date): Promise<void> {
  const timeStr = typeof time === 'string' ? time : time.toISOString();
  const result = await restCall('POST', '/test/clock/mock', { time: timeStr });
  if (!result.success) {
    throw new Error(`Failed to set clock: ${result.error}`);
  }
}

/**
 * Advance mock clock
 */
export async function advanceClock(duration: {
  days?: number;
  hours?: number;
  minutes?: number;
}): Promise<void> {
  const result = await restCall('POST', '/test/clock/advance', duration);
  if (!result.success) {
    throw new Error(`Failed to advance clock: ${result.error}`);
  }
}

/**
 * Reset clock to real time
 */
export async function resetClock(): Promise<void> {
  const result = await restCall('POST', '/test/clock/real');
  if (!result.success) {
    throw new Error(`Failed to reset clock: ${result.error}`);
  }
}

/**
 * Get current clock status
 */
export async function getClockStatus(): Promise<{
  type: 'real' | 'mock';
  currentTime: string;
}> {
  const result = await restCall<any>('GET', '/test/clock');
  if (!result.success || !result.data) {
    throw new Error(`Failed to get clock status: ${result.error}`);
  }
  return result.data;
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
 * Reset test data (delete customer and related data)
 */
export async function resetTestData(walletAddress?: string): Promise<void> {
  const result = await restCall('POST', '/test/data/reset', { walletAddress });
  if (!result.success) {
    throw new Error(`Failed to reset test data: ${result.error}`);
  }
}

/**
 * Truncate all tables (complete database reset)
 */
export async function truncateAllTables(): Promise<void> {
  const result = await restCall('POST', '/test/data/truncate-all');
  if (!result.success) {
    throw new Error(`Failed to truncate tables: ${result.error}`);
  }
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
