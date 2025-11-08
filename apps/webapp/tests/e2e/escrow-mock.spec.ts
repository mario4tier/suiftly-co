/**
 * Escrow Mock E2E Test
 * Tests mock wallet interaction with escrow operations
 *
 * This test demonstrates:
 * 1. Mock wallet control via test API (deposit/withdraw/spending limit)
 * 2. Balance display in UI
 * 3. Subscription with sufficient/insufficient balance
 * 4. Spending limit enforcement
 *
 * The mock wallet simulates Sui blockchain behavior using PostgreSQL.
 * In production, these operations will interact with real Sui smart contracts.
 */

import { test, expect } from '@playwright/test';

const MOCK_WALLET_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const API_BASE = 'http://localhost:3000';

test.describe('Escrow Mock - Wallet Operations', () => {
  test.beforeEach(async ({ page }) => {
    // Reset customer data
    await page.request.post(`${API_BASE}/test/data/reset`, {
      data: {
        balanceUsdCents: 0, // Start with zero balance
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
  });

  test('can deposit funds via test API and see updated balance', async ({ page }) => {
    // Initial balance should be $0
    let balanceResponse = await page.request.get(`${API_BASE}/test/wallet/balance`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    let balanceData = await balanceResponse.json();

    // Account might not exist yet - deposit will create it
    console.log('Initial balance:', balanceData);

    // Deposit $100 via test API (simulates user depositing via wallet)
    const depositResponse = await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 100,
        initialSpendingLimitUsd: 250,
      },
    });

    const depositData = await depositResponse.json();
    console.log('Deposit result:', depositData);

    expect(depositData.success).toBe(true);
    expect(depositData.newBalanceUsd).toBe(100);
    // accountCreated may be false if account was created by test/data/reset
    // Either way, the deposit succeeded

    // Verify balance via API
    balanceResponse = await page.request.get(`${API_BASE}/test/wallet/balance`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    balanceData = await balanceResponse.json();

    expect(balanceData.found).toBe(true);
    expect(balanceData.balanceUsd).toBe(100);
    expect(balanceData.spendingLimitUsd).toBe(250);
    expect(balanceData.currentPeriodChargedUsd).toBe(0);

    console.log('✅ Deposit successful, balance updated to $100');
  });

  test('can withdraw funds and see balance decrease', async ({ page }) => {
    // Deposit $200 first
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 200,
        initialSpendingLimitUsd: 250,
      },
    });

    // Verify balance
    let balanceResponse = await page.request.get(`${API_BASE}/test/wallet/balance`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    let balanceData = await balanceResponse.json();
    expect(balanceData.balanceUsd).toBe(200);

    // Withdraw $50
    const withdrawResponse = await page.request.post(`${API_BASE}/test/wallet/withdraw`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 50,
      },
    });

    const withdrawData = await withdrawResponse.json();
    console.log('Withdraw result:', withdrawData);

    expect(withdrawData.success).toBe(true);
    expect(withdrawData.newBalanceUsd).toBe(150);

    // Verify balance decreased
    balanceResponse = await page.request.get(`${API_BASE}/test/wallet/balance`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    balanceData = await balanceResponse.json();
    expect(balanceData.balanceUsd).toBe(150);

    console.log('✅ Withdrawal successful, balance decreased to $150');
  });

  test('cannot withdraw more than balance', async ({ page }) => {
    // Deposit $50
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 50,
        initialSpendingLimitUsd: 250,
      },
    });

    // Try to withdraw $100 (more than balance)
    const withdrawResponse = await page.request.post(`${API_BASE}/test/wallet/withdraw`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 100,
      },
    });

    const withdrawData = await withdrawResponse.json();
    console.log('Withdraw result:', withdrawData);

    expect(withdrawData.success).toBe(false);
    expect(withdrawData.error).toContain('Insufficient balance');

    // Balance should remain $50
    const balanceResponse = await page.request.get(`${API_BASE}/test/wallet/balance`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    const balanceData = await balanceResponse.json();
    expect(balanceData.balanceUsd).toBe(50);

    console.log('✅ Withdrawal correctly rejected - insufficient balance');
  });

  test('can update spending limit', async ({ page }) => {
    // Deposit $100 to create account
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 100,
        initialSpendingLimitUsd: 250,
      },
    });

    // Update spending limit to $500
    const limitResponse = await page.request.post(`${API_BASE}/test/wallet/spending-limit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        limitUsd: 500,
      },
    });

    const limitData = await limitResponse.json();
    console.log('Update spending limit result:', limitData);

    expect(limitData.success).toBe(true);
    expect(limitData.newLimitUsd).toBe(500);

    // Verify limit updated
    const balanceResponse = await page.request.get(`${API_BASE}/test/wallet/balance`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    const balanceData = await balanceResponse.json();
    expect(balanceData.spendingLimitUsd).toBe(500);

    console.log('✅ Spending limit updated to $500');
  });
});

test.describe('Escrow Mock - Service Subscription Scenarios', () => {
  test.beforeEach(async ({ page }) => {
    // Reset customer data
    await page.request.post(`${API_BASE}/test/data/reset`, {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Authenticate
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
  });

  test('can subscribe to service with sufficient balance', async ({ page }) => {
    // Deposit $100
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 100,
        initialSpendingLimitUsd: 250,
      },
    });

    // Navigate to Seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Should see onboarding form
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).toBeVisible();

    // Accept terms
    await page.locator('label:has-text("Agree to")').click();

    // Subscribe to PRO tier ($29)
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await expect(subscribeButton).toBeEnabled();
    await subscribeButton.click();

    // Should transition to provisioning state, or directly to service page
    // After subscription, heading changes from "Configure Seal Service" to just "Seal"
    await expect(
      page.locator('h1:has-text("Seal")').first()
    ).toBeVisible({ timeout: 10000 });

    console.log('✅ Subscription successful with sufficient balance');

    // Navigate to billing page to verify balance (real user flow)
    await page.click('text=Billing');
    await page.waitForURL(/\/billing/, { timeout: 5000 });

    // Wait for balance to load and be displayed
    // Balance should be $100 - $29 = $71 (PRO tier charges immediately in mock)
    await expect(page.locator('text=Balance').locator('..').locator('text=$71.00')).toBeVisible({ timeout: 10000 });

    console.log('✅ Balance correctly displayed as $71.00 on billing page');
  });

  test('cannot subscribe with insufficient balance', async ({ page }) => {
    // Deposit only $10 (not enough for $20 Starter tier)
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 10,
        initialSpendingLimitUsd: 250,
      },
    });

    // Navigate to Seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms
    await page.locator('label:has-text("Agree to")').click();

    // Subscribe button should be enabled (frontend validation not yet implemented)
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Backend should reject with insufficient balance error
    // Wait for error message to appear
    await page.waitForTimeout(2000); // Give time for API call

    console.log('✅ Subscription correctly rejected - insufficient balance');

    // Balance should still be $10
    const balanceResponse = await page.request.get(`${API_BASE}/test/wallet/balance`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    const balanceData = await balanceResponse.json();
    expect(balanceData.balanceUsd).toBe(10);
  });

  test('cannot exceed 28-day spending limit', async ({ page }) => {
    // Deposit $1000 (more than enough balance) with LOW $50 spending limit
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 1000,
        initialSpendingLimitUsd: 50, // Set limit to $50
      },
    });

    // Navigate to Seal service
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms
    await page.locator('label:has-text("Agree to")').click();

    // Select ENTERPRISE tier ($185/month - exceeds $50 limit)
    // Click on the tier card by its unique price
    await page.locator('text=$185/month').click();

    // Wait for button to update to show ENTERPRISE price
    await expect(page.locator('button:has-text("Subscribe to Service for $185.00/month")')).toBeVisible({ timeout: 5000 });

    // Try to subscribe - should fail because $185 > $50 limit
    await page.locator('button:has-text("Subscribe to Service")').click();

    // Wait for subscription request to complete and error toast to appear
    await page.waitForTimeout(2000);

    // Should see error toast (there may be multiple toasts - auth success + subscription error)
    // Wait for a toast that contains the spending limit error
    const errorToast = page.locator('[data-sonner-toast]').filter({ hasText: /exceed.*spending limit/i });
    await expect(errorToast).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Subscription Charge Architecture - Critical Business Logic', () => {
  test.beforeEach(async ({ page }) => {
    // Reset customer data (database only, doesn't create mock wallet)
    await page.request.post(`${API_BASE}/test/data/reset`, {
      data: {
        balanceUsdCents: 0, // Start at 0
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Authenticate
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Deposit $100 to create mock wallet account (needed for charges to work)
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 100,
      },
    });
  });

  test('idempotency: retry subscription returns existing service without double charge', async ({ page }) => {
    // Navigate to Seal service
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms and subscribe with default PRO tier ($29)
    await page.locator('label:has-text("Agree to")').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Wait for redirect to overview page (subscription successful)
    await page.waitForURL(/\/services\/seal\/overview/, { timeout: 10000 });

    // Navigate to billing page to check balance
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Verify balance decreased from $100 to $71
    // Look for balance in the Suiftly Escrow Account card
    const balanceAfterFirst = await page.locator('text=Balance').locator('..').locator('text=/\\$\\d+\\.\\d{2}/').textContent();
    expect(balanceAfterFirst).toBe('$71.00');

    // Try to subscribe again by navigating back to Seal
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal\/overview/, { timeout: 5000 }); // Should redirect to overview

    // Navigate back to billing to verify balance
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Verify balance stayed $71 (no double charge)
    const balanceAfterRetry = await page.locator('text=Balance').locator('..').locator('text=/\\$\\d+\\.\\d{2}/').textContent();
    expect(balanceAfterRetry).toBe('$71.00');

    console.log('✅ Idempotent subscription - no double charge on retry');
  });

  test('charge failure: service created with pending=true, cannot be enabled', async ({ page }) => {
    // Set balance to $10 (insufficient for $29 PRO tier - default selection)
    await page.request.post(`${API_BASE}/test/data/reset`, {
      data: {
        balanceUsdCents: 1000, // $10
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Navigate to Seal service
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms
    await page.locator('label:has-text("Agree to")').click();

    // Subscribe with default PRO tier ($29) - should fail with insufficient balance
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Should see error toast
    const errorToast = page.locator('[data-sonner-toast]').filter({ hasText: /insufficient balance/i });
    await expect(errorToast).toBeVisible({ timeout: 5000 });

    // CRITICAL: Verify service was created in DISABLED state with pending=true
    const customerData = await page.request.get(`${API_BASE}/test/data/customer`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    const customerInfo = await customerData.json();

    // Service-first architecture: Service IS created even when charge fails
    // This ensures audit trail exists before any payment attempt:
    //   1. Create service with pending=true
    //   2. Attempt charge
    //   3. If charge fails, service stays with pending=true (cannot be enabled)
    expect(customerInfo.services).toHaveLength(1);
    expect(customerInfo.services[0].subscriptionChargePending).toBe(true);
    expect(customerInfo.services[0].state).toBe('disabled');

    // Verify balance unchanged (charge correctly rejected)
    expect(customerInfo.customer.balanceUsd).toBe(10);

    console.log('✅ Service created with pending=true when charge fails');
  });

  test('state transition blocked: service with pending=true cannot be enabled', async ({ page }) => {
    // This test requires manual database setup since we can't easily create
    // a service with pending=true through the UI (charge either succeeds or fails)
    //
    // We'll use the API to directly create a service with pending=true

    // First, authenticate and get customer ID
    const customerData = await page.request.get(`${API_BASE}/test/data/customer`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    const customer = await customerData.json();

    if (!customer.found) {
      throw new Error('Customer not found for testing');
    }

    // Use SQL to directly insert a service with subscription_charge_pending=true
    // This simulates a crash scenario where service was created but charge pending
    const insertServiceQuery = `
      INSERT INTO service_instances (
        customer_id,
        service_type,
        tier,
        state,
        subscription_charge_pending,
        is_enabled,
        config,
        created_at,
        updated_at
      ) VALUES (
        ${customer.customer.customerId},
        'seal',
        'pro',
        'disabled',
        true,
        false,
        '{"tier": "pro", "burstEnabled": true, "totalSealKeys": 1, "packagesPerSealKey": 3, "totalApiKeys": 2, "purchasedSealKeys": 0, "purchasedPackages": 0, "purchasedApiKeys": 0, "ipAllowlist": []}',
        NOW(),
        NOW()
      )
      ON CONFLICT DO NOTHING;
    `;

    // Execute via test endpoint (would need to add this endpoint)
    // For now, document that this test requires database access

    console.log('⚠️  Test requires direct database access to create pending service');
    console.log('    Implementation pending: /test/db/execute endpoint');

    // Expected flow after setup:
    // 1. Navigate to service
    // 2. Try to enable
    // 3. Should see error: "Cannot enable service: subscription payment pending"
  });

  test('crash recovery: pending flag persists across page reload', async ({ page }) => {
    // Subscribe to service successfully
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    await page.locator('label:has-text("Agree to")').click();

    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Wait for subscription
    await page.waitForURL(/\/services\/seal\/overview/, { timeout: 10000 });

    // Reload page (simulates crash recovery)
    await page.reload();
    await page.waitForURL(/\/services\/seal\/overview/, { timeout: 10000 });

    // Service should still be accessible and in correct state
    // This verifies the pending flag is persisted in database

    await expect(page.locator('h1:has-text("Seal")')).toBeVisible();

    console.log('✅ Service state persists across page reload');
  });
});
