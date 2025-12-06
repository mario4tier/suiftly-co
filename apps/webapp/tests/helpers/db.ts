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
