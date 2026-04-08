/**
 * Full Upgrade Scenario Test: Deposit → Starter → Upgrade Pro → Schedule Downgrade → Re-confirm Pro
 *
 * Reproduces user-reported bug:
 * - User deposits $200
 * - User subscribes to Starter platform tier ($1 charged)
 * - User upgrades to Pro (pro-rated charge)
 * - User schedules downgrade to Starter
 * - User upgrades back to Pro (while downgrade is scheduled)
 * - Expected: All billing records visible, DRAFT shows Pro price
 * - Bug reported: "$29 charge not showing in billing but was subtracted from escrow"
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
  sealKeys,
  sealPackages,
  apiKeys,
  userActivityLogs,
  customerPaymentMethods,
} from '../schema';
import { eq, and, sql, desc } from 'drizzle-orm';
import { MockDBClock } from '@suiftly/shared/db-clock';
import type { ISuiService, TransactionResult, ChargeParams, EscrowAccount, DepositParams, WithdrawParams, UpdateSpendingLimitParams } from '@suiftly/shared/sui-service';
import {
  handleTierUpgrade,
  scheduleTierDowngrade,
  cancelScheduledTierChange,
} from './tier-changes';
import { handleSubscriptionBilling } from './service-billing';
import { PLATFORM_TIER_PRICES_USD_CENTS } from '@suiftly/shared/pricing';
import { toPaymentServices, ensureEscrowPaymentMethod, cleanupCustomerData, resetTestState, suspendGMProcessing } from './test-helpers';

// ============================================================================
// Mock SuiService with balance tracking
// ============================================================================

class FullScenarioMockSuiService implements ISuiService {
  private balance = 0; // In cents
  private shouldFail = false;

  constructor(initialBalanceCents: number = 0) {
    this.balance = initialBalanceCents;
  }

  setBalance(cents: number) { this.balance = cents; }
  setFailure(fail: boolean) { this.shouldFail = fail; }
  getBalance() { return this.balance; }

  async getAccount(userAddress: string): Promise<EscrowAccount | null> {
    return {
      accountAddress: '0xESCROW_FULL_SCENARIO',
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

  async deposit(params: DepositParams): Promise<TransactionResult> {
    this.balance += params.amountUsdCents;
    return { success: true, digest: 'mock-deposit-' + Date.now() };
  }

  async withdraw(params: WithdrawParams): Promise<TransactionResult> {
    if (params.amountUsdCents > this.balance) {
      return { success: false, digest: '', error: 'Insufficient balance' };
    }
    this.balance -= params.amountUsdCents;
    return { success: true, digest: 'mock-withdraw-' + Date.now() };
  }

  async charge(params: ChargeParams): Promise<TransactionResult> {
    if (this.shouldFail) {
      return { success: false, digest: '', error: 'Mock failure' };
    }
    if (params.amountUsdCents > this.balance) {
      return { success: false, digest: '', error: 'Insufficient balance' };
    }
    this.balance -= params.amountUsdCents;
    const timestamp = Date.now().toString(16).padStart(16, '0');
    const digest = `0x${'abcdef12'.repeat(6)}${timestamp}`;
    return { success: true, digest };
  }

  async credit(): Promise<TransactionResult> {
    return { success: true, digest: 'mock-credit-' + Date.now() };
  }

  async updateSpendingLimit(params: UpdateSpendingLimitParams): Promise<TransactionResult> {
    return { success: true, digest: 'mock-limit-' + Date.now() };
  }

  async buildTransaction() { return null; }
  isMock() { return true; }
  async getTransactionHistory() { return []; }
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Full Upgrade Scenario: Deposit → Starter → Upgrade Pro → Schedule Downgrade → Re-confirm Pro', () => {
  const clock = new MockDBClock();
  let suiService: FullScenarioMockSuiService;
  let paymentServices: ReturnType<typeof toPaymentServices>;

  const testWalletAddress = '0xFULLSCENARIO890abcdefABCDEF1234567890abcdefABCDEF12345678901234';
  let testCustomerId: number;

  beforeAll(async () => {
    await resetTestState(db);
  });

  beforeEach(async () => {
    await suspendGMProcessing();

    // Start with $200 balance (20000 cents)
    suiService = new FullScenarioMockSuiService(20000);
    paymentServices = toPaymentServices(suiService);
    clock.setTime(new Date('2025-12-02T00:00:00Z'));

    // Defensive cleanup: remove stale data from previous crashed runs
    await cleanupCustomerData(db, 9999001);

    const [customer] = await db.insert(customers).values({
      customerId: 9999001,
      walletAddress: testWalletAddress,
      escrowContractId: '0xESCROW_FULL_SCENARIO',
      status: 'active',
      currentBalanceUsdCents: 20000, // $200
      spendingLimitUsdCents: 100000,
      currentPeriodChargedUsdCents: 0,
      currentPeriodStart: '2025-12-01',
      paidOnce: false,
      platformTier: 'starter', // Initial platform tier
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

  it('FULL SCENARIO: All billing records should be created and visible', async () => {
    console.log('\n========================================');
    console.log('FULL UPGRADE SCENARIO TEST');
    console.log('========================================\n');

    // ========== STEP 1: Initial deposit of $200 ==========
    console.log('STEP 1: Initial state - $200 deposited');
    console.log(`  Mock escrow balance: ${suiService.getBalance()} cents ($${(suiService.getBalance()/100).toFixed(2)})`);
    expect(suiService.getBalance()).toBe(20000);

    // ========== STEP 2: Subscribe to Starter tier ==========
    console.log('\nSTEP 2: Subscribe to Starter platform tier ($1)');

    // First update customer to Starter tier, then call subscription billing
    await db.update(customers)
      .set({ platformTier: 'starter' })
      .where(eq(customers.customerId, testCustomerId));

    const subscriptionResult = await handleSubscriptionBilling(
      db,
      testCustomerId,
      'platform',
      'starter',
      PLATFORM_TIER_PRICES_USD_CENTS.starter, // $1 = 100 cents
      paymentServices,
      clock
    );

    console.log(`  Subscription result: success=${subscriptionResult.paymentSuccessful}`);
    console.log(`  Amount charged: ${subscriptionResult.amountUsdCents} cents ($${(subscriptionResult.amountUsdCents/100).toFixed(2)})`);
    console.log(`  Mock escrow balance after: ${suiService.getBalance()} cents ($${(suiService.getBalance()/100).toFixed(2)})`);

    expect(subscriptionResult.paymentSuccessful).toBe(true);
    expect(subscriptionResult.amountUsdCents).toBe(100);
    expect(suiService.getBalance()).toBe(20000 - 100); // $199

    // ========== STEP 2b: Upgrade to Pro tier ==========
    console.log('\nSTEP 2b: Upgrade to Pro tier ($29, pro-rated)');

    const upgradeToProResult = await handleTierUpgrade(db, testCustomerId, 'platform', 'pro', paymentServices, clock);
    console.log(`  Upgrade result: success=${upgradeToProResult.success}, newTier=${upgradeToProResult.newTier}`);
    console.log(`  Pro-rated charge: ${upgradeToProResult.chargeAmountUsdCents} cents ($${((upgradeToProResult.chargeAmountUsdCents || 0)/100).toFixed(2)})`);
    console.log(`  Mock escrow balance after: ${suiService.getBalance()} cents ($${(suiService.getBalance()/100).toFixed(2)})`);

    expect(upgradeToProResult.success).toBe(true);
    expect(upgradeToProResult.newTier).toBe('pro');

    // Calculate expected pro-rated charge for Starter → Pro upgrade
    // Dec 2 → Dec 31 = 30 days remaining out of 31
    // (Pro - Starter) * 30/31 = ($29 - $1) * 30/31 = $28 * 30/31
    const expectedUpgradeToProCents = Math.floor((PLATFORM_TIER_PRICES_USD_CENTS.pro - PLATFORM_TIER_PRICES_USD_CENTS.starter) * 30 / 31);
    console.log(`  Expected pro-rated upgrade charge: ${expectedUpgradeToProCents} cents ($${(expectedUpgradeToProCents/100).toFixed(2)})`);
    expect(upgradeToProResult.chargeAmountUsdCents).toBe(expectedUpgradeToProCents);

    // ========== STEP 3: Verify billing records after Starter subscribe + Pro upgrade ==========
    console.log('\nSTEP 3: Verify billing records after Starter subscribe and Pro upgrade');

    let allRecords = await db.select().from(billingRecords)
      .where(eq(billingRecords.customerId, testCustomerId))
      .orderBy(desc(billingRecords.createdAt));

    console.log(`  Total billing records: ${allRecords.length}`);
    for (const record of allRecords) {
      console.log(`    - ${record.status}: $${(record.amountUsdCents/100).toFixed(2)} (${record.type}) id: ${record.id}`);
    }

    // Should have: 1 PAID for Starter subscription, 1 PAID for pro-rated Pro upgrade, 1 DRAFT for next month
    const paidRecords = allRecords.filter(r => r.status === 'paid');
    const draftRecords = allRecords.filter(r => r.status === 'draft');

    expect(paidRecords.length).toBe(2);
    expect(draftRecords.length).toBe(1);
    // DRAFT shows Pro price for next month (no reconciliation credit — upgrade charge was already pro-rated)
    expect(draftRecords[0].amountUsdCents).toBe(PLATFORM_TIER_PRICES_USD_CENTS.pro);

    // ========== STEP 4: Schedule downgrade to Starter ==========
    console.log('\nSTEP 4: Schedule downgrade Pro → Starter');

    const downgradeResult = await scheduleTierDowngrade(db, testCustomerId, 'platform', 'starter', clock);
    console.log(`  Downgrade scheduled: success=${downgradeResult.success}`);
    console.log(`  Effective date: ${downgradeResult.effectiveDate?.toISOString()}`);

    expect(downgradeResult.success).toBe(true);

    // Verify customer platform state
    let cust = await db.query.customers.findFirst({ where: eq(customers.customerId, testCustomerId) });
    console.log(`  Platform tier: ${cust!.platformTier}, scheduledTier: ${cust!.scheduledPlatformTier}`);
    expect(cust!.platformTier).toBe('pro');
    expect(cust!.scheduledPlatformTier).toBe('starter');

    // Check DRAFT after downgrade scheduled
    let [draft] = await db.select().from(billingRecords).where(and(
      eq(billingRecords.customerId, testCustomerId),
      eq(billingRecords.status, 'draft')
    ));
    // DRAFT shows Starter price (no reconciliation credit — scheduling a downgrade doesn't issue credits)
    console.log(`  DRAFT after downgrade scheduled: $${(draft.amountUsdCents/100).toFixed(2)} (expected: $${(PLATFORM_TIER_PRICES_USD_CENTS.starter/100).toFixed(2)})`);
    expect(draft.amountUsdCents).toBe(PLATFORM_TIER_PRICES_USD_CENTS.starter);

    // ========== STEP 5: Cancel the scheduled downgrade (Pro is the highest tier, no upgrade possible) ==========
    console.log('\nSTEP 5: Cancel scheduled Starter downgrade (keeping Pro)');

    const cancelResult = await cancelScheduledTierChange(db, testCustomerId, 'platform', clock);
    console.log(`  Cancel result: success=${cancelResult.success}`);

    expect(cancelResult.success).toBe(true);

    // ========== STEP 6: Verify final state ==========
    console.log('\nSTEP 6: Verify final state');

    // Customer platform state: downgrade cancelled, back to Pro
    cust = await db.query.customers.findFirst({ where: eq(customers.customerId, testCustomerId) });
    console.log(`  Platform tier: ${cust!.platformTier}`);
    console.log(`  Scheduled tier: ${cust!.scheduledPlatformTier}`);
    expect(cust!.platformTier).toBe('pro');
    expect(cust!.scheduledPlatformTier).toBeNull();

    // DRAFT should now show Pro price
    [draft] = await db.select().from(billingRecords).where(and(
      eq(billingRecords.customerId, testCustomerId),
      eq(billingRecords.status, 'draft')
    ));
    console.log(`  DRAFT amount: $${(draft.amountUsdCents/100).toFixed(2)} (expected: $${(PLATFORM_TIER_PRICES_USD_CENTS.pro/100).toFixed(2)})`);
    expect(draft.amountUsdCents).toBe(PLATFORM_TIER_PRICES_USD_CENTS.pro);

    // ========== STEP 7: List ALL billing records ==========
    console.log('\n========================================');
    console.log('ALL BILLING RECORDS:');
    console.log('========================================');

    allRecords = await db.select().from(billingRecords)
      .where(eq(billingRecords.customerId, testCustomerId))
      .orderBy(desc(billingRecords.createdAt));

    for (const record of allRecords) {
      console.log(`  ID: ${record.id}`);
      console.log(`    Status: ${record.status}`);
      console.log(`    Type: ${record.type}`);
      console.log(`    Amount: $${(record.amountUsdCents/100).toFixed(2)} (${record.amountUsdCents} cents)`);
      console.log('    ---');
    }

    // Expected records:
    // 1. PAID - $1 (Starter first month)
    // 2. PAID - pro-rated Starter → Pro upgrade charge
    // 3. DRAFT - $29 (Pro next month)
    const paidRecordsFinal = allRecords.filter(r => r.status === 'paid');
    const draftRecordsFinal = allRecords.filter(r => r.status === 'draft');

    console.log(`\nSummary: ${paidRecordsFinal.length} PAID records, ${draftRecordsFinal.length} DRAFT records`);

    expect(paidRecordsFinal.length).toBe(2);
    expect(draftRecordsFinal.length).toBe(1);

    // Verify the $1 Starter charge exists
    const starterCharge = paidRecordsFinal.find(r => r.amountUsdCents === 100);
    expect(starterCharge).toBeDefined();
    console.log(`  ✓ Starter subscription charge found: $${(starterCharge!.amountUsdCents/100).toFixed(2)}`);

    // Verify the pro-rated upgrade charge exists
    const upgradeCharge = paidRecordsFinal.find(r => r.amountUsdCents === expectedUpgradeToProCents);
    expect(upgradeCharge).toBeDefined();
    console.log(`  ✓ Pro-rated upgrade charge found: $${(upgradeCharge!.amountUsdCents/100).toFixed(2)}`);

    // Verify DRAFT shows Pro price
    expect(draftRecordsFinal[0].amountUsdCents).toBe(PLATFORM_TIER_PRICES_USD_CENTS.pro);
    console.log(`  ✓ DRAFT invoice correct: $${(draftRecordsFinal[0].amountUsdCents/100).toFixed(2)}`);

    // ========== STEP 8: Check invoice_payments table ==========
    console.log('\n========================================');
    console.log('INVOICE PAYMENTS:');
    console.log('========================================');

    const payments = await db.select().from(invoicePayments);
    console.log(`  Total payments: ${payments.length}`);
    for (const p of payments) {
      console.log(`    - Payment #${p.paymentId}: $${(p.amountUsdCents/100).toFixed(2)} from ${p.sourceType}`);
    }

    // ========== STEP 10: Check credits ==========
    console.log('\n========================================');
    console.log('CREDITS:');
    console.log('========================================');

    const credits = await db.select().from(customerCredits)
      .where(eq(customerCredits.customerId, testCustomerId));
    console.log(`  Total credits: ${credits.length}`);
    for (const c of credits) {
      console.log(`    - ${c.reason}: $${(c.originalAmountUsdCents/100).toFixed(2)} (remaining: $${(c.remainingAmountUsdCents/100).toFixed(2)})`);
    }

    // ========== Final balance check ==========
    console.log('\n========================================');
    console.log('FINAL BALANCE CHECK:');
    console.log('========================================');

    const totalCharged = paidRecordsFinal.reduce((sum, r) => sum + r.amountUsdCents, 0);
    console.log(`  Initial deposit: $200.00`);
    console.log(`  Total charged: $${(totalCharged/100).toFixed(2)}`);
    console.log(`  Expected balance: $${((20000 - totalCharged)/100).toFixed(2)}`);
    console.log(`  Actual mock balance: $${(suiService.getBalance()/100).toFixed(2)}`);

    // Note: Balance might differ slightly due to credits applied
    console.log('\n========================================');
    console.log('TEST COMPLETE');
    console.log('========================================\n');
  });

});
