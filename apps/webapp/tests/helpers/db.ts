/**
 * Database test utilities
 * Helpers for resetting database state in Playwright tests
 *
 * IMPORTANT: Uses deploy user TRUNCATE permission (no sudo required)
 */

import type { APIRequestContext } from '@playwright/test';

const API_BASE = 'http://localhost:22700'; // See ~/walrus/PORT_MAP.md

export interface ResetCustomerOptions {
  walletAddress?: string;
}

/**
 * Reset customer to production defaults by deleting and recreating
 *
 * This ensures tests validate production behavior, not test-specific code paths.
 *
 * Process:
 * - Deletes customer and all related data
 * - Customer will be recreated with production defaults on next auth
 *
 * Production defaults (from auth.ts):
 * - Balance: $0
 * - Spending limit: $250
 *
 * For tests that need specific balances, use ensureTestBalance() after resetting.
 */
export async function resetCustomer(
  request: APIRequestContext,
  options?: ResetCustomerOptions
): Promise<void> {
  const response = await request.post(`${API_BASE}/test/data/reset`, {
    data: options,
  });

  if (!response.ok()) {
    throw new Error(`Failed to reset customer: ${await response.text()}`);
  }
}

/**
 * Truncate all database tables (TRUNCATE-based, no sudo required)
 * - Clears ALL data from ALL tables
 * - Resets all sequences (auto-increment IDs)
 * - Fast and clean for complete database reset
 *
 * Use this when you need a completely clean database state.
 */
export async function truncateAllTables(
  request: APIRequestContext
): Promise<void> {
  const response = await request.post(`${API_BASE}/test/data/truncate-all`);

  if (!response.ok()) {
    const error = await response.text();
    throw new Error(`Failed to truncate tables: ${error}`);
  }
}

/**
 * Get current customer state (for debugging)
 */
export async function getCustomerData(
  request: APIRequestContext,
  walletAddress?: string
): Promise<any> {
  const url = walletAddress
    ? `${API_BASE}/test/data/customer?walletAddress=${walletAddress}`
    : `${API_BASE}/test/data/customer`;

  const response = await request.get(url);

  if (!response.ok()) {
    throw new Error(`Failed to get customer data: ${await response.text()}`);
  }

  return response.json();
}

/**
 * Create an API key for testing (returns plain key for HAProxy tests)
 * - Uses production API key generation code
 * - Returns plain key so tests can use it in X-API-Key headers
 * - Key is encrypted with test SECRET_KEY (shared with HAProxy)
 *
 * @returns Object with success, customerId, apiKeyFp, and plainKey
 */
export async function createApiKey(
  request: APIRequestContext,
  walletAddress?: string
): Promise<{ success: boolean; customerId?: number; apiKeyFp?: number; plainKey?: string; error?: string }> {
  const response = await request.post(`${API_BASE}/test/data/create-api-key`, {
    data: walletAddress ? { walletAddress } : {},
  });

  if (!response.ok()) {
    throw new Error(`Failed to create API key: ${await response.text()}`);
  }

  return response.json();
}

/**
 * Setup seal service with cpEnabled=true for control plane sync tests
 * - Creates service instance (subscribed)
 * - Creates seal key
 * - Creates package (triggers cpEnabled=true)
 *
 * Use this when tests need to trigger vault generation.
 */
export async function setupCpEnabled(
  request: APIRequestContext,
  walletAddress?: string
): Promise<{ success: boolean; customerId?: number; sealKeyId?: number; error?: string }> {
  const response = await request.post(`${API_BASE}/test/data/setup-cp-enabled`, {
    data: walletAddress ? { walletAddress } : {},
  });

  if (!response.ok()) {
    throw new Error(`Failed to setup cpEnabled: ${await response.text()}`);
  }

  return response.json();
}

/**
 * Query recent HAProxy raw logs from the database
 * Used to verify that requests through HAProxy are being logged
 *
 * @param options.since - Only return logs after this timestamp (ISO string or Date)
 * @param options.limit - Maximum number of logs to return (default 10)
 * @param options.statusCode - Filter by status code
 * @param options.pathPrefix - Filter by path prefix (e.g., 'v1/health')
 */
export interface HaproxyLogEntry {
  timestamp: string;
  customerId: number | null;
  pathPrefix: string | null;
  network: number;
  serverId: number;
  serviceType: number;
  apiKeyFp: number;
  feType: number;
  trafficType: number;
  eventType: number;
  statusCode: number;
  bytesSent: number;
  timeTotal: number;
  clientIp: string;
  repeat: number;
}

export async function getRecentHaproxyLogs(
  request: APIRequestContext,
  options?: {
    since?: string | Date;
    limit?: number;
    statusCode?: number;
    pathPrefix?: string;
  }
): Promise<HaproxyLogEntry[]> {
  const params = new URLSearchParams();
  if (options?.since) {
    const sinceStr = options.since instanceof Date ? options.since.toISOString() : options.since;
    params.set('since', sinceStr);
  }
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.statusCode) params.set('statusCode', String(options.statusCode));
  if (options?.pathPrefix) params.set('pathPrefix', options.pathPrefix);

  const url = `${API_BASE}/test/data/haproxy-logs?${params.toString()}`;
  const response = await request.get(url);

  if (!response.ok()) {
    throw new Error(`Failed to get HAProxy logs: ${await response.text()}`);
  }

  const data = await response.json();
  return data.logs || [];
}

/**
 * Wait for HAProxy logs to appear in the database
 * Useful for E2E tests that need to verify log ingestion through fluentd pipeline
 *
 * @param options.since - Only look for logs after this timestamp
 * @param options.minCount - Minimum number of logs expected (default 1)
 * @param options.timeout - Max time to wait in ms (default 15000)
 * @param options.pollInterval - Poll interval in ms (default 1000)
 */
export async function waitForHaproxyLogs(
  request: APIRequestContext,
  options: {
    since: string | Date;
    minCount?: number;
    timeout?: number;
    pollInterval?: number;
    statusCode?: number;
    pathPrefix?: string;
  }
): Promise<HaproxyLogEntry[]> {
  const minCount = options.minCount ?? 1;
  const timeout = options.timeout ?? 15000;
  const pollInterval = options.pollInterval ?? 1000;
  const maxAttempts = Math.ceil(timeout / pollInterval);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const logs = await getRecentHaproxyLogs(request, {
      since: options.since,
      statusCode: options.statusCode,
      pathPrefix: options.pathPrefix,
      limit: 100,
    });

    if (logs.length >= minCount) {
      console.log(`Found ${logs.length} HAProxy log(s) after ${(attempt + 1) * pollInterval}ms`);
      return logs;
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `Timeout waiting for HAProxy logs: expected >= ${minCount}, found 0 after ${timeout}ms`
  );
}

/**
 * Ensure the test wallet has a specific balance
 * - Deposits or withdraws as needed to reach the target balance
 * - Creates escrow account if it doesn't exist
 * - Idempotent: can be called multiple times safely
 */
export async function ensureTestBalance(
  request: APIRequestContext,
  targetBalanceUsd: number,
  options?: {
    walletAddress?: string;
    spendingLimitUsd?: number;
  }
): Promise<void> {
  const walletAddress = options?.walletAddress || '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  // Get current balance
  const balanceResponse = await request.get(`${API_BASE}/test/wallet/balance`, {
    params: { walletAddress },
  });

  const balanceData = await balanceResponse.json();

  if (!balanceData.found) {
    // Account doesn't exist, create it with deposit
    const depositResponse = await request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress,
        amountUsd: targetBalanceUsd,
        initialSpendingLimitUsd: options?.spendingLimitUsd || 250,
      },
    });

    const depositData = await depositResponse.json();
    if (!depositData.success) {
      throw new Error(`Failed to create escrow account: ${depositData.error}`);
    }
    return;
  }

  const currentBalance = balanceData.balanceUsd;
  const diff = targetBalanceUsd - currentBalance;

  // Update spending limit if specified
  if (options?.spendingLimitUsd !== undefined) {
    const updateLimitResponse = await request.post(`${API_BASE}/test/wallet/spending-limit`, {
      data: {
        walletAddress,
        limitUsd: options.spendingLimitUsd,
      },
    });

    const updateData = await updateLimitResponse.json();
    if (!updateData.success) {
      throw new Error(`Failed to update spending limit: ${updateData.error}`);
    }
  }

  if (Math.abs(diff) < 0.01) {
    // Already at target balance (within 1 cent)
    return;
  }

  if (diff > 0) {
    // Need to deposit
    const depositResponse = await request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress,
        amountUsd: diff,
      },
    });

    const depositData = await depositResponse.json();
    if (!depositData.success) {
      throw new Error(`Failed to deposit: ${depositData.error}`);
    }
  } else {
    // Need to withdraw
    const withdrawResponse = await request.post(`${API_BASE}/test/wallet/withdraw`, {
      data: {
        walletAddress,
        amountUsd: Math.abs(diff),
      },
    });

    const withdrawData = await withdrawResponse.json();
    if (!withdrawData.success) {
      throw new Error(`Failed to withdraw: ${withdrawData.error}`);
    }
  }
}
