/**
 * Database Reset Example
 * Demonstrates two approaches for resetting test data
 */

import { test, expect } from '@playwright/test';
import { truncateAllTables, resetCustomer } from '../helpers/db';

const MOCK_WALLET_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test.describe('Database Reset Example', () => {
  /**
   * Approach 1: Per-customer reset (DELETE-based)
   * Use when you only need to reset one customer's data
   */
  test('per-customer reset - keeps other customers intact', async ({ page }) => {
    // Reset specific customer to clean state
    await resetCustomer(page.request, {
      balanceUsdCents: 100000, // $1000
      spendingLimitUsdCents: 25000, // $250
    });

    // Test continues with clean customer state...
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await page.waitForURL('/dashboard');
  });

  /**
   * Approach 2: Full database truncate (TRUNCATE-based)
   * Use when you need a completely clean database
   * IMPORTANT: No sudo required (uses deploy user TRUNCATE permission)
   */
  test('full database reset - completely clean state', async ({ page }) => {
    // Truncate all tables (fast, no sudo required)
    await truncateAllTables(page.request);

    // Database is now completely empty
    // You may need to seed initial data here

    await page.goto('/');
    // Note: Mock wallet login will fail because customers table is empty
    // You would typically seed a test customer after truncate
  });
});
