/**
 * Full Upgrade Scenario Test: Deposit → Pro → Schedule Downgrade → Upgrade to Enterprise
 *
 * Reproduces user-reported bug:
 * - User deposits $200
 * - User subscribes to Pro tier ($29 charged)
 * - User schedules downgrade to Starter
 * - User upgrades to Enterprise instead
 * - Expected: All billing records visible, DRAFT shows Enterprise price
 * - Bug reported: "$29 charge not showing in billing but was subtracted from escrow"
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { db } from '../db';
import {
  customers,
  serviceInstances,
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
} from './tier-changes';
import { handleSubscriptionBilling } from './service-billing';
import { TIER_PRICES_USD_CENTS } from '@suiftly/shared/pricing';
import { toPaymentServices, ensureEscrowPaymentMethod, cleanupCustomerData } from './test-helpers';

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

describe('Full Upgrade Scenario: Deposit → Pro → Schedule Downgrade → Enterprise', () => {
  const clock = new MockDBClock();
  let suiService: FullScenarioMockSuiService;
  let paymentServices: ReturnType<typeof toPaymentServices>;

  const testWalletAddress = '0xFULLSCENARIO890abcdefABCDEF1234567890abcdefABCDEF12345678901234';
  let testCustomerId: number;

  beforeEach(async () => {
    // Start with $200 balance (20000 cents)
    suiService = new FullScenarioMockSuiService(20000);
    paymentServices = toPaymentServices(suiService);
    clock.setTime(new Date('2025-12-02T00:00:00Z'));

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
      createdAt: clock.now(),
      updatedAt: clock.now(),
    }).returning();

    testCustomerId = customer.customerId;

    // Create service instance (not yet subscribed - no tier set yet, will be set on subscribe)
    await db.insert(serviceInstances).values({
      customerId: testCustomerId,
      serviceType: 'seal',
      tier: 'starter', // Initial tier before subscribing
      state: 'disabled',
      isUserEnabled: false,
      subPendingInvoiceId: null,
      paidOnce: false,
      config: {},
    });

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

    // ========== STEP 2: Subscribe to Pro tier ==========
    console.log('\nSTEP 2: Subscribe to Pro tier ($29)');

    // First update service to Pro tier, then call subscription billing
    await db.update(serviceInstances)
      .set({ tier: 'pro', state: 'enabled', isUserEnabled: true })
      .where(eq(serviceInstances.customerId, testCustomerId));

    const subscriptionResult = await handleSubscriptionBilling(
      db,
      testCustomerId,
      'seal',
      'pro',
      TIER_PRICES_USD_CENTS.pro, // $29 = 2900 cents
      paymentServices,
      clock
    );

    console.log(`  Subscription result: success=${subscriptionResult.paymentSuccessful}`);
    console.log(`  Amount charged: ${subscriptionResult.amountUsdCents} cents ($${(subscriptionResult.amountUsdCents/100).toFixed(2)})`);
    console.log(`  Mock escrow balance after: ${suiService.getBalance()} cents ($${(suiService.getBalance()/100).toFixed(2)})`);

    expect(subscriptionResult.paymentSuccessful).toBe(true);
    expect(subscriptionResult.amountUsdCents).toBe(2900);
    expect(suiService.getBalance()).toBe(20000 - 2900); // $171

    // ========== STEP 3: Verify billing record for Pro subscription ==========
    console.log('\nSTEP 3: Verify billing record for Pro subscription');

    let allRecords = await db.select().from(billingRecords)
      .where(eq(billingRecords.customerId, testCustomerId))
      .orderBy(desc(billingRecords.createdAt));

    console.log(`  Total billing records: ${allRecords.length}`);
    for (const record of allRecords) {
      console.log(`    - ${record.status}: $${(record.amountUsdCents/100).toFixed(2)} (${record.type}) id: ${record.id}`);
    }

    // Should have: 1 PAID for Pro subscription, 1 DRAFT for next month
    const paidRecords = allRecords.filter(r => r.status === 'paid');
    const draftRecords = allRecords.filter(r => r.status === 'draft');

    expect(paidRecords.length).toBe(1);
    expect(paidRecords[0].amountUsdCents).toBe(2900);
    expect(draftRecords.length).toBe(1);
    expect(draftRecords[0].amountUsdCents).toBe(TIER_PRICES_USD_CENTS.pro);

    // ========== STEP 4: Schedule downgrade to Starter ==========
    console.log('\nSTEP 4: Schedule downgrade Pro → Starter');

    const downgradeResult = await scheduleTierDowngrade(db, testCustomerId, 'seal', 'starter', clock);
    console.log(`  Downgrade scheduled: success=${downgradeResult.success}`);
    console.log(`  Effective date: ${downgradeResult.effectiveDate?.toISOString()}`);

    expect(downgradeResult.success).toBe(true);

    // Verify service state
    let [service] = await db.select().from(serviceInstances).where(eq(serviceInstances.customerId, testCustomerId));
    console.log(`  Service tier: ${service.tier}, scheduledTier: ${service.scheduledTier}`);
    expect(service.tier).toBe('pro');
    expect(service.scheduledTier).toBe('starter');

    // Check DRAFT after downgrade scheduled
    let [draft] = await db.select().from(billingRecords).where(and(
      eq(billingRecords.customerId, testCustomerId),
      eq(billingRecords.status, 'draft')
    ));
    console.log(`  DRAFT after downgrade scheduled: $${(draft.amountUsdCents/100).toFixed(2)} (expected: $${(TIER_PRICES_USD_CENTS.starter/100).toFixed(2)})`);
    expect(draft.amountUsdCents).toBe(TIER_PRICES_USD_CENTS.starter);

    // ========== STEP 5: Upgrade to Enterprise (while downgrade is scheduled) ==========
    console.log('\nSTEP 5: Upgrade to Enterprise (while Starter downgrade is scheduled)');

    const upgradeResult = await handleTierUpgrade(db, testCustomerId, 'seal', 'enterprise', paymentServices, clock);
    console.log(`  Upgrade result: success=${upgradeResult.success}, newTier=${upgradeResult.newTier}`);
    console.log(`  Pro-rated charge: ${upgradeResult.chargeAmountUsdCents} cents ($${((upgradeResult.chargeAmountUsdCents || 0)/100).toFixed(2)})`);
    console.log(`  Mock escrow balance after: ${suiService.getBalance()} cents ($${(suiService.getBalance()/100).toFixed(2)})`);

    expect(upgradeResult.success).toBe(true);
    expect(upgradeResult.newTier).toBe('enterprise');

    // Calculate expected pro-rated charge
    // Dec 2 → Dec 31 = 30 days remaining out of 31
    // (Enterprise - Pro) * 30/31 = ($185 - $29) * 30/31 = $156 * 30/31 = $150.97
    const expectedProRatedCents = Math.floor((TIER_PRICES_USD_CENTS.enterprise - TIER_PRICES_USD_CENTS.pro) * 30 / 31);
    console.log(`  Expected pro-rated: ${expectedProRatedCents} cents ($${(expectedProRatedCents/100).toFixed(2)})`);
    expect(upgradeResult.chargeAmountUsdCents).toBe(expectedProRatedCents);

    // ========== STEP 6: Verify final state ==========
    console.log('\nSTEP 6: Verify final state');

    // Service state
    [service] = await db.select().from(serviceInstances).where(eq(serviceInstances.customerId, testCustomerId));
    console.log(`  Service tier: ${service.tier}`);
    console.log(`  Scheduled tier: ${service.scheduledTier}`);
    expect(service.tier).toBe('enterprise');
    expect(service.scheduledTier).toBeNull();

    // DRAFT should now show Enterprise price
    [draft] = await db.select().from(billingRecords).where(and(
      eq(billingRecords.customerId, testCustomerId),
      eq(billingRecords.status, 'draft')
    ));
    console.log(`  DRAFT amount: $${(draft.amountUsdCents/100).toFixed(2)} (expected: $${(TIER_PRICES_USD_CENTS.enterprise/100).toFixed(2)})`);
    expect(draft.amountUsdCents).toBe(TIER_PRICES_USD_CENTS.enterprise);

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
    // 1. PAID - $29 (Pro first month)
    // 2. PAID - ~$150.97 (Pro-rated upgrade)
    // 3. DRAFT - $185 (Enterprise next month)
    const paidRecordsFinal = allRecords.filter(r => r.status === 'paid');
    const draftRecordsFinal = allRecords.filter(r => r.status === 'draft');

    console.log(`\nSummary: ${paidRecordsFinal.length} PAID records, ${draftRecordsFinal.length} DRAFT records`);

    expect(paidRecordsFinal.length).toBe(2);
    expect(draftRecordsFinal.length).toBe(1);

    // Verify the $29 Pro charge exists
    const proCharge = paidRecordsFinal.find(r => r.amountUsdCents === 2900);
    expect(proCharge).toBeDefined();
    console.log(`  ✓ Pro subscription charge found: $${(proCharge!.amountUsdCents/100).toFixed(2)}`);

    // Verify the pro-rated upgrade charge exists
    const upgradeCharge = paidRecordsFinal.find(r => r.amountUsdCents === expectedProRatedCents);
    expect(upgradeCharge).toBeDefined();
    console.log(`  ✓ Pro-rated upgrade charge found: $${(upgradeCharge!.amountUsdCents/100).toFixed(2)}`);

    // Verify DRAFT
    expect(draftRecordsFinal[0].amountUsdCents).toBe(TIER_PRICES_USD_CENTS.enterprise);
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
