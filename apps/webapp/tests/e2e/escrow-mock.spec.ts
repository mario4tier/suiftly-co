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
import { waitAfterMutation, waitForCondition } from '../helpers/wait-utils';
import { subscribePlatformService } from '../helpers/db';
import { PLATFORM_TIER_PRICES_USD_CENTS } from '@suiftly/shared/pricing';

const MOCK_WALLET_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const API_BASE = 'http://localhost:22700';

const STARTER_PRICE = PLATFORM_TIER_PRICES_USD_CENTS.starter; // cents
const PRO_PRICE = PLATFORM_TIER_PRICES_USD_CENTS.pro; // cents
const STARTER_PRICE_USD = STARTER_PRICE / 100;
const PRO_PRICE_USD = PRO_PRICE / 100;

test.describe('Escrow Mock - Wallet Operations', () => {
  test.beforeEach(async ({ page }) => {
    // Reset customer data
    await page.request.post(`${API_BASE}/test/data/reset`, {
      data: {
        balanceUsdCents: 0, // Start with zero balance
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Clear cookies for clean auth state (prevents test pollution)
    await page.context().clearCookies();

    // Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');

    // Wait for auth to process (smart wait - returns as soon as network idle)
    await waitAfterMutation(page);

    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
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

    // Clear cookies for clean auth state (prevents test pollution)
    await page.context().clearCookies();

    // Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');

    // Wait for auth to process (smart wait - returns as soon as network idle)
    await waitAfterMutation(page);

    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
  });

  test('can subscribe to platform with sufficient balance', async ({ page }) => {
    // Deposit $100 (auto-adds escrow as payment method)
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 100,
        initialSpendingLimitUsd: 250,
      },
    });

    // Subscribe to platform Starter via the platform subscription UI
    await subscribePlatformService(page);

    // Verify via API that balance decreased by Starter price (charged immediately via escrow)
    const balanceResponse = await page.request.get(`${API_BASE}/test/wallet/balance`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    const balanceData = await balanceResponse.json();
    expect(balanceData.balanceUsd).toBe(100 - STARTER_PRICE_USD);

    console.log(`✅ Balance correctly updated to $${100 - STARTER_PRICE_USD}.00 after platform Starter subscription`);
  });

  test('platform subscription with insufficient Pro balance creates pending payment', async ({ page }) => {
    // Deposit $10 (enough for Starter, but not Pro)
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 10,
        initialSpendingLimitUsd: 250,
      },
    });

    // Navigate to billing and subscribe to Pro tier
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Select Pro tier
    await page.locator('text=Pro').first().click();
    await page.locator('#platform-tos').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to")');
    await expect(subscribeButton).toBeEnabled({ timeout: 5000 });
    await subscribeButton.click();
    await waitAfterMutation(page);

    // Subscription is created but payment is pending (escrow $10 < Pro)
    const balanceResponse = await page.request.get(`${API_BASE}/test/wallet/balance`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    const balanceData = await balanceResponse.json();
    // Balance unchanged — charge was blocked (insufficient funds for Pro)
    expect(balanceData.balanceUsd).toBe(10);

    console.log('✅ Pro subscription payment pending - balance unchanged at $10');
  });

  test('cannot exceed 28-day spending limit', async ({ page }) => {
    // Create escrow account with $1000 balance but LOW $10 spending limit
    await page.request.post(`${API_BASE}/test/data/reset`, {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 0,
        clearEscrowAccount: true, // Remove escrow account to start fresh
      },
    });
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 1000,
        initialSpendingLimitUsd: 10, // $10 limit — blocks Pro
      },
    });

    // Navigate to billing, select Pro tier (exceeds $10 limit), subscribe
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });
    await page.locator('text=Pro').first().click();
    await page.locator('#platform-tos').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to")');
    await expect(subscribeButton).toBeEnabled({ timeout: 5000 });
    await subscribeButton.click();
    await waitAfterMutation(page);

    // Wait for platform service to be created in database (with polling)
    await waitForCondition(
      async () => {
        const response = await page.request.get(`${API_BASE}/test/data/customer`, {
          params: { walletAddress: MOCK_WALLET_ADDRESS },
        });
        const data = await response.json();
        // Platform tier set on customer; seal/grpc/graphql only provisioned after successful payment
        return data.customer && data.customer.platformTier !== null;
      },
      { timeout: 5000, message: 'Platform subscription to be created in database' }
    );

    // Verify spending limit was enforced (service-first architecture):
    // Service IS created with subscriptionChargePending=true when charge fails
    const customerData = await page.request.get(`${API_BASE}/test/data/customer`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    const customerInfo = await customerData.json();

    // 1. Platform subscription was created on customer; seal/grpc/graphql NOT yet provisioned
    expect(customerInfo.customer.platformTier).toBe('pro');
    expect(customerInfo.services).toHaveLength(0);

    // 2. But charge is pending (failed due to spending limit)
    // Platform subscription is active (it's a billing concept, not infrastructure)
    // The pending invoice is what blocks further provisioning
    expect(customerInfo.customer.subscriptionChargePending).toBe(true);

    // 3. Balance unchanged - charge was rejected
    expect(customerInfo.customer.balanceUsd).toBe(1000);

    console.log('✅ Spending limit enforced - service created with pending=true, charge blocked');
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

    // Clear cookies for clean auth state (prevents test pollution)
    await page.context().clearCookies();

    // Authenticate — wait for networkidle to ensure frontend config is loaded
    // (config flags set above need to propagate to the frontend SPA)
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await waitAfterMutation(page);
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');

    // Deposit $100 to create mock wallet account (needed for charges to work)
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 100,
      },
    });
  });

  test('idempotency: retry subscription returns existing service without double charge', async ({ page }) => {
    // Subscribe to PRO using the helper (handles tier selection + TOS)
    await subscribePlatformService(page, 'PRO');
    await page.goto('/services/seal/overview');
    await page.waitForLoadState('networkidle');

    // Verify balance decreased via API (robust — no DOM scraping race)
    const expectedBalance = 100 - PRO_PRICE_USD;
    const balanceAfterFirst = await page.request.get(`${API_BASE}/test/wallet/balance`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    const afterFirstData = await balanceAfterFirst.json();
    expect(afterFirstData.balanceUsd).toBe(expectedBalance);

    // Try to subscribe again by navigating back to Seal
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal\/overview/, { timeout: 5000 }); // Should redirect to overview

    // Verify balance stayed the same (no double charge) — via API
    const balanceAfterRetry = await page.request.get(`${API_BASE}/test/wallet/balance`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    const afterRetryData = await balanceAfterRetry.json();
    expect(afterRetryData.balanceUsd).toBe(expectedBalance);

    console.log('✅ Idempotent subscription - no double charge on retry');
  });

  test('charge failure: service created with pending=true, cannot be enabled', async ({ page }) => {
    // beforeEach deposited $100 and added escrow payment method.
    // Reset balance to $10 (insufficient for Pro, but escrow method remains).
    await page.request.post(`${API_BASE}/test/data/reset`, {
      data: {
        balanceUsdCents: 1000, // $10
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Navigate to billing and subscribe to platform PRO (> $10 escrow)
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });
    await page.locator('text=Pro').first().click();
    await page.locator('#platform-tos').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to")');
    await expect(subscribeButton).toBeEnabled({ timeout: 5000 });
    await subscribeButton.click();
    await waitAfterMutation(page);

    // Should see warning banner about pending payment
    const pendingBanner = page.locator('text=Subscription payment pending');
    await expect(pendingBanner).toBeVisible({ timeout: 5000 });

    // CRITICAL: Verify service was created with pending invoice
    const customerData = await page.request.get(`${API_BASE}/test/data/customer`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    const customerInfo = await customerData.json();

    // Platform subscription is set on customer even when charge fails (payment pending).
    // No seal/grpc/graphql services are auto-provisioned until payment succeeds.
    expect(customerInfo.services).toHaveLength(0);
    expect(customerInfo.customer.platformTier).toBe('pro');
    expect(customerInfo.customer.subscriptionChargePending).toBe(true);

    // Verify balance unchanged (charge correctly rejected - insufficient funds)
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

  test('crash recovery: platform subscription state persists across page reload', async ({ page }) => {
    // Subscribe to platform (auto-provisions seal)
    await subscribePlatformService(page, 'PRO');

    // Navigate to seal overview (auto-provisioned after platform subscription)
    await page.goto('/services/seal/overview');
    await page.waitForLoadState('networkidle');

    // Reload page (simulates crash recovery)
    await page.reload();
    await page.waitForURL(/\/services\/seal\/overview/, { timeout: 10000 });

    // Seal should still be accessible in disabled state (not enabled yet - user must toggle)
    await expect(page.locator('h1:has-text("Seal")')).toBeVisible();

    console.log('✅ Service state persists across page reload');
  });
});
