/**
 * Database test utilities
 * Helpers for resetting database state in Playwright tests
 *
 * IMPORTANT: Uses deploy user TRUNCATE permission (no sudo required)
 */

import type { APIRequestContext } from '@playwright/test';

const API_BASE = 'http://localhost:3000';

export interface ResetCustomerOptions {
  walletAddress?: string;
  balanceUsdCents?: number;
  spendingLimitUsdCents?: number;
}

/**
 * Reset a specific customer's data (DELETE-based)
 * - Deletes all services, API keys, Seal keys, ledger entries
 * - Resets balance and spending limit
 * - Keeps customer record
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
