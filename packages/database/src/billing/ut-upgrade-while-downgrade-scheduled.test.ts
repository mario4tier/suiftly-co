/**
 * Bug Reproduction Test: Upgrade while downgrade is scheduled
 *
 * Scenario (as described by user):
 * 1. User is on Pro tier
 * 2. User schedules downgrade to Starter (DRAFT should show Starter price)
 * 3. User tries to "cancel" the downgrade by pressing Change Plan
 * 4. User upgrades back to Pro (Pro is the highest platform tier)
 * 5. DRAFT invoice gets messed up
 *
 * Expected after upgrade:
 * - service.tier = 'pro'
 * - service.scheduledTier = null (cleared)
 * - DRAFT invoice amount = Pro price ($29)
 *
 * What might be going wrong:
 * - DRAFT shows Starter price instead of Pro
 * - DRAFT shows Starter price (scheduled tier not cleared)
 * - DRAFT shows wrong amount entirely
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { db } from '../db';
import {
  customers,
  billingRecords,
  customerCredits,
  invoicePayments,
  billingIdempotency,
  escrowTransactions,
  mockSuiTransactions,
  apiKeys,
  userActivityLogs,
  customerPaymentMethods,
} from '../schema';
import { eq, and, sql } from 'drizzle-orm';
import { MockDBClock } from '@suiftly/shared/db-clock';
import type { ISuiService, TransactionResult, ChargeParams, EscrowAccount } from '@suiftly/shared/sui-service';
import {
  scheduleTierDowngrade,
  cancelScheduledTierChange,
} from './tier-changes';
import { PLATFORM_TIER_PRICES_USD_CENTS } from '@suiftly/shared/pricing';
import { toPaymentServices, ensureEscrowPaymentMethod, cleanupCustomerData, resetTestState, suspendGMProcessing } from './test-helpers';

// ============================================================================
// Test Utilities
// ============================================================================

class TestMockSuiService implements ISuiService {
  private shouldFail = false;
  private balance = 100000;

  setFailure(fail: boolean) { this.shouldFail = fail; }
  setBalance(balance: number) { this.balance = balance; }

  async getAccount(userAddress: string): Promise<EscrowAccount | null> {
    return {
      accountAddress: '0xESCROW',
      userAddress,
      suiftlyAddress: '0xSUIFTLY',
      balanceUsdCents: this.balance,
      spendingLimitUsdCents: 100000,
      currentPeriodChargedUsdCents: 0,
      currentPeriodStartMs: Date.now(),
    };
  }

  async syncAccount(userAddress: string): Promise<EscrowAccount | null> {
    return this.getAccount(userAddress);
  }

  async deposit(): Promise<TransactionResult> {
    return { success: true, digest: 'mock-deposit-' + Date.now() };
  }

  async withdraw(): Promise<TransactionResult> {
    return { success: true, digest: 'mock-withdraw-' + Date.now() };
  }

  async charge(params: ChargeParams): Promise<TransactionResult> {
    if (this.shouldFail) {
      return { success: false, digest: '', error: 'Mock failure' };
    }
    this.balance -= params.amountUsdCents;
    const timestamp = Date.now().toString(16).padStart(16, '0');
    const digest = `0x${'deadbeef'.repeat(6)}${timestamp}`;
    return { success: true, digest };
  }

  async credit(): Promise<TransactionResult> {
    return { success: true, digest: 'mock-credit-' + Date.now() };
  }

  async updateSpendingLimit(): Promise<TransactionResult> {
    return { success: true, digest: 'mock-limit-' + Date.now() };
  }

  async buildTransaction() { return null; }
  isMock() { return true; }
  async getTransactionHistory() { return []; }
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Bug: Upgrade while downgrade is scheduled', () => {
  const clock = new MockDBClock();
  const suiService = new TestMockSuiService();
  const paymentServices = toPaymentServices(suiService);

  const testWalletAddress = '0xUPGRADEDOWNGRADE567890abcdefABCDEF1234567890abcdefABCDEF12345';
  let testCustomerId: number;

  beforeAll(async () => {
    await resetTestState(db);
  });

  beforeEach(async () => {
    await suspendGMProcessing();

    suiService.setFailure(false);
    suiService.setBalance(100000);
    clock.setTime(new Date('2025-01-15T00:00:00Z'));

    // Defensive cleanup: remove stale data from previous crashed runs
    await cleanupCustomerData(db, 8888);

    const [customer] = await db.insert(customers).values({
      customerId: 8888,
      walletAddress: testWalletAddress,
      escrowContractId: '0xESCROW8888',
      status: 'active',
      currentBalanceUsdCents: 50000,
      spendingLimitUsdCents: 100000,
      currentPeriodChargedUsdCents: 0,
      currentPeriodStart: '2025-01-01',
      paidOnce: true,
      platformTier: 'pro',
      pendingInvoiceId: null,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    }).returning();

    testCustomerId = customer.customerId;

    // Ensure escrow payment method exists for provider chain
    await ensureEscrowPaymentMethod(db, testCustomerId);
  });

  afterEach(async () => {
    await cleanupCustomerData(db, testCustomerId);
  });

  it('SCENARIO: Schedule downgrade then cancel it - DRAFT should show Pro price', async () => {
    // With only Starter/Pro tiers, there is no higher tier to "upgrade to" while a downgrade
    // is scheduled. The correct resolution is cancelScheduledTierChange. This test verifies
    // that canceling a scheduled downgrade properly restores the DRAFT to the Pro price.
    console.log('\n========================================');
    console.log('SCENARIO: Schedule downgrade then cancel - DRAFT should show Pro price');
    console.log('========================================\n');

    // ========== STEP 1: Initial state ==========
    console.log('STEP 1: Initial state');
    let customer = await db.query.customers.findFirst({ where: eq(customers.customerId, testCustomerId) });
    console.log(`  tier: ${customer!.platformTier}`);
    console.log(`  scheduledTier: ${customer!.scheduledPlatformTier}`);
    expect(customer!.platformTier).toBe('pro');
    expect(customer!.scheduledPlatformTier).toBeNull();

    // ========== STEP 2: Schedule downgrade Pro → Starter ==========
    console.log('\nSTEP 2: Schedule downgrade Pro → Starter');
    const downgradeResult = await scheduleTierDowngrade(db, testCustomerId, 'platform', 'starter', clock);
    console.log(`  Result: success=${downgradeResult.success}`);
    expect(downgradeResult.success).toBe(true);

    customer = await db.query.customers.findFirst({ where: eq(customers.customerId, testCustomerId) });
    expect(customer!.platformTier).toBe('pro'); // Still Pro
    expect(customer!.scheduledPlatformTier).toBe('starter'); // Starter scheduled

    let [draft] = await db.select().from(billingRecords).where(and(
      eq(billingRecords.customerId, testCustomerId),
      eq(billingRecords.status, 'draft')
    ));
    console.log(`  DRAFT amount: ${draft?.amountUsdCents} cents (expected: ${PLATFORM_TIER_PRICES_USD_CENTS.starter} = Starter)`);
    expect(draft.amountUsdCents).toBe(PLATFORM_TIER_PRICES_USD_CENTS.starter);

    // ========== STEP 3: Cancel the scheduled downgrade ==========
    console.log('\nSTEP 3: Cancel scheduled downgrade (Pro is the highest tier, no upgrade possible)');
    const cancelResult = await cancelScheduledTierChange(db, testCustomerId, 'platform', clock);
    console.log(`  Result: success=${cancelResult.success}`);
    expect(cancelResult.success).toBe(true);

    // ========== STEP 4: Verify final state ==========
    console.log('\nSTEP 4: Verify final state');
    customer = await db.query.customers.findFirst({ where: eq(customers.customerId, testCustomerId) });
    console.log(`  tier: ${customer!.platformTier}, scheduledTier: ${customer!.scheduledPlatformTier}`);
    expect(customer!.platformTier).toBe('pro');
    expect(customer!.scheduledPlatformTier).toBeNull();
    expect(customer!.scheduledPlatformTierEffectiveDate).toBeNull();

    [draft] = await db.select().from(billingRecords).where(and(
      eq(billingRecords.customerId, testCustomerId),
      eq(billingRecords.status, 'draft')
    ));
    console.log(`  DRAFT amount: ${draft?.amountUsdCents} cents (expected: ${PLATFORM_TIER_PRICES_USD_CENTS.pro} = Pro)`);
    expect(draft.amountUsdCents).toBe(PLATFORM_TIER_PRICES_USD_CENTS.pro);

    console.log('\n========================================');
    console.log('TEST PASSED - DRAFT shows correct Pro price after cancel');
    console.log('========================================\n');
  });

  it('should show all billing records after schedule downgrade + cancel', async () => {
    // Setup: schedule downgrade then cancel — verify billing record state
    await scheduleTierDowngrade(db, testCustomerId, 'platform', 'starter', clock);
    await cancelScheduledTierChange(db, testCustomerId, 'platform', clock);

    const allRecords = await db.select().from(billingRecords).where(
      eq(billingRecords.customerId, testCustomerId)
    );

    console.log('\n========================================');
    console.log('ALL BILLING RECORDS FOR CUSTOMER:');
    console.log('========================================');
    for (const record of allRecords) {
      console.log(`  ID: ${record.id}`);
      console.log(`    status: ${record.status}`);
      console.log(`    type: ${record.type}`);
      console.log(`    amount: ${record.amountUsdCents} cents ($${(record.amountUsdCents / 100).toFixed(2)})`);
      console.log('    ---');
    }

    // After cancel: only the DRAFT for next month at Pro price
    const draftRecords = allRecords.filter(r => r.status === 'draft');
    expect(draftRecords.length).toBe(1);
    expect(draftRecords[0].amountUsdCents).toBe(PLATFORM_TIER_PRICES_USD_CENTS.pro);

    console.log('\nDRAFT invoice is correct: $' + (draftRecords[0].amountUsdCents / 100).toFixed(2));
  });

  it('alternative scenario: cancel scheduled downgrade and verify state is clean', async () => {
    // Canceling a scheduled downgrade is the only way to "undo" it with a 2-tier model.
    // Verify: after cancel, tier=Pro, scheduledTier=null, DRAFT=Pro price.
    console.log('\n========================================');
    console.log('ALTERNATIVE: Cancel scheduled downgrade, verify clean state');
    console.log('========================================\n');

    // Step 1: Schedule downgrade
    await scheduleTierDowngrade(db, testCustomerId, 'platform', 'starter', clock);

    let customer = await db.query.customers.findFirst({ where: eq(customers.customerId, testCustomerId) });
    expect(customer!.scheduledPlatformTier).toBe('starter');

    let [draft] = await db.select().from(billingRecords).where(and(
      eq(billingRecords.customerId, testCustomerId),
      eq(billingRecords.status, 'draft')
    ));
    console.log(`  DRAFT after schedule downgrade: ${draft?.amountUsdCents} cents (should be Starter = ${PLATFORM_TIER_PRICES_USD_CENTS.starter})`);
    expect(draft.amountUsdCents).toBe(PLATFORM_TIER_PRICES_USD_CENTS.starter);

    // Step 2: Cancel the scheduled downgrade
    console.log('Canceling scheduled downgrade...');
    const cancelResult = await cancelScheduledTierChange(db, testCustomerId, 'platform', clock);
    console.log(`  Cancel result: success=${cancelResult.success}`);
    expect(cancelResult.success).toBe(true);

    customer = await db.query.customers.findFirst({ where: eq(customers.customerId, testCustomerId) });
    console.log(`  After cancel: tier=${customer!.platformTier}, scheduledTier=${customer!.scheduledPlatformTier}`);
    expect(customer!.platformTier).toBe('pro');
    expect(customer!.scheduledPlatformTier).toBeNull();

    [draft] = await db.select().from(billingRecords).where(and(
      eq(billingRecords.customerId, testCustomerId),
      eq(billingRecords.status, 'draft')
    ));
    console.log(`  Final DRAFT: ${draft?.amountUsdCents} cents (should be Pro = ${PLATFORM_TIER_PRICES_USD_CENTS.pro})`);
    expect(draft.amountUsdCents).toBe(PLATFORM_TIER_PRICES_USD_CENTS.pro);

    console.log('\n========================================');
    console.log('ALTERNATIVE SCENARIO PASSED');
    console.log('========================================\n');
  });
});
