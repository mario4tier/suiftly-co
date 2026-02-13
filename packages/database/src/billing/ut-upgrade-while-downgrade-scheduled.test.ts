/**
 * Bug Reproduction Test: Upgrade while downgrade is scheduled
 *
 * Scenario (as described by user):
 * 1. User is on Pro tier
 * 2. User schedules downgrade to Starter (DRAFT should show Starter price)
 * 3. User tries to "cancel" the downgrade by pressing Change Plan
 * 4. User accidentally upgrades to Enterprise instead
 * 5. DRAFT invoice gets messed up
 *
 * Expected after upgrade:
 * - service.tier = 'enterprise'
 * - service.scheduledTier = null (cleared)
 * - DRAFT invoice amount = Enterprise price ($185)
 *
 * What might be going wrong:
 * - DRAFT shows Pro price instead of Enterprise
 * - DRAFT shows Starter price (scheduled tier not cleared)
 * - DRAFT shows wrong amount entirely
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
} from '../schema';
import { eq, and, sql } from 'drizzle-orm';
import { MockDBClock } from '@suiftly/shared/db-clock';
import type { ISuiService, TransactionResult, ChargeParams, EscrowAccount } from '@suiftly/shared/sui-service';
import {
  handleTierUpgrade,
  scheduleTierDowngrade,
  cancelScheduledTierChange,
} from './tier-changes';
import { TIER_PRICES_USD_CENTS } from '@suiftly/shared/pricing';

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

  const testWalletAddress = '0xUPGRADEDOWNGRADE567890abcdefABCDEF1234567890abcdefABCDEF12345';
  let testCustomerId: number;

  beforeAll(async () => {
    await db.execute(sql`TRUNCATE TABLE user_activity_logs CASCADE`);
    await db.execute(sql`TRUNCATE TABLE billing_idempotency CASCADE`);
    await db.execute(sql`TRUNCATE TABLE invoice_payments CASCADE`);
    await db.execute(sql`TRUNCATE TABLE billing_records CASCADE`);
    await db.execute(sql`TRUNCATE TABLE customer_credits CASCADE`);
    await db.execute(sql`TRUNCATE TABLE seal_packages CASCADE`);
    await db.execute(sql`TRUNCATE TABLE seal_keys CASCADE`);
    await db.execute(sql`TRUNCATE TABLE api_keys CASCADE`);
    await db.execute(sql`TRUNCATE TABLE service_instances CASCADE`);
    await db.execute(sql`TRUNCATE TABLE escrow_transactions CASCADE`);
    await db.execute(sql`TRUNCATE TABLE mock_sui_transactions CASCADE`);
    await db.execute(sql`TRUNCATE TABLE customers CASCADE`);
  });

  beforeEach(async () => {
    suiService.setFailure(false);
    suiService.setBalance(100000);
    clock.setTime(new Date('2025-01-15T00:00:00Z'));

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
      createdAt: clock.now(),
      updatedAt: clock.now(),
    }).returning();

    testCustomerId = customer.customerId;

    // Start with Pro tier, already paid
    await db.insert(serviceInstances).values({
      customerId: testCustomerId,
      serviceType: 'seal',
      tier: 'pro',
      state: 'enabled',
      isUserEnabled: true,
      subPendingInvoiceId: null,
      paidOnce: true,
      config: {},
    });
  });

  afterEach(async () => {
    await db.delete(userActivityLogs);
    await db.delete(billingIdempotency);
    await db.delete(invoicePayments);
    await db.delete(billingRecords);
    await db.delete(customerCredits);
    await db.delete(sealPackages);
    await db.delete(sealKeys);
    await db.delete(apiKeys);
    await db.delete(serviceInstances);
    await db.delete(escrowTransactions);
    await db.delete(mockSuiTransactions);
    await db.delete(customers);
  });

  it('SCENARIO: Schedule downgrade then upgrade - DRAFT should show Enterprise price', async () => {
    console.log('\n========================================');
    console.log('REPRODUCING: Upgrade while downgrade scheduled');
    console.log('========================================\n');

    // ========== STEP 1: Initial state ==========
    console.log('STEP 1: Initial state');
    let [service] = await db.select().from(serviceInstances).where(eq(serviceInstances.customerId, testCustomerId));
    console.log(`  tier: ${service.tier}`);
    console.log(`  scheduledTier: ${service.scheduledTier}`);
    console.log(`  Expected: tier=pro, scheduledTier=null`);
    expect(service.tier).toBe('pro');
    expect(service.scheduledTier).toBeNull();

    // ========== STEP 2: Schedule downgrade Pro → Starter ==========
    console.log('\nSTEP 2: Schedule downgrade Pro → Starter');
    const downgradeResult = await scheduleTierDowngrade(db, testCustomerId, 'seal', 'starter', clock);
    console.log(`  Result: success=${downgradeResult.success}`);
    expect(downgradeResult.success).toBe(true);

    [service] = await db.select().from(serviceInstances).where(eq(serviceInstances.customerId, testCustomerId));
    console.log(`  tier: ${service.tier}`);
    console.log(`  scheduledTier: ${service.scheduledTier}`);
    console.log(`  scheduledTierEffectiveDate: ${service.scheduledTierEffectiveDate}`);
    expect(service.tier).toBe('pro'); // Still Pro
    expect(service.scheduledTier).toBe('starter'); // Starter scheduled

    let [draft] = await db.select().from(billingRecords).where(and(
      eq(billingRecords.customerId, testCustomerId),
      eq(billingRecords.status, 'draft')
    ));
    console.log(`  DRAFT amount: ${draft?.amountUsdCents} cents`);
    console.log(`  Expected DRAFT: ${TIER_PRICES_USD_CENTS.starter} cents (Starter = $9)`);
    expect(draft.amountUsdCents).toBe(TIER_PRICES_USD_CENTS.starter);

    // ========== STEP 3: Upgrade Pro → Enterprise (while Starter is scheduled) ==========
    console.log('\nSTEP 3: Upgrade Pro → Enterprise (while Starter is scheduled)');
    const upgradeResult = await handleTierUpgrade(db, testCustomerId, 'seal', 'enterprise', suiService, clock);
    console.log(`  Result: success=${upgradeResult.success}, newTier=${upgradeResult.newTier}`);
    console.log(`  Charge amount: ${upgradeResult.chargeAmountUsdCents} cents`);
    expect(upgradeResult.success).toBe(true);
    expect(upgradeResult.newTier).toBe('enterprise');

    // ========== STEP 4: Verify final state ==========
    console.log('\nSTEP 4: Verify final state');
    [service] = await db.select().from(serviceInstances).where(eq(serviceInstances.customerId, testCustomerId));
    console.log(`  tier: ${service.tier}`);
    console.log(`  scheduledTier: ${service.scheduledTier}`);
    console.log(`  scheduledTierEffectiveDate: ${service.scheduledTierEffectiveDate}`);
    console.log(`  Expected: tier=enterprise, scheduledTier=null`);

    // Critical assertions
    expect(service.tier).toBe('enterprise');
    expect(service.scheduledTier).toBeNull();
    expect(service.scheduledTierEffectiveDate).toBeNull();

    [draft] = await db.select().from(billingRecords).where(and(
      eq(billingRecords.customerId, testCustomerId),
      eq(billingRecords.status, 'draft')
    ));
    console.log(`  DRAFT amount: ${draft?.amountUsdCents} cents`);
    console.log(`  Expected DRAFT: ${TIER_PRICES_USD_CENTS.enterprise} cents (Enterprise = $185)`);

    // THE CRITICAL CHECK - is DRAFT correct?
    expect(draft.amountUsdCents).toBe(TIER_PRICES_USD_CENTS.enterprise);

    console.log('\n========================================');
    console.log('TEST PASSED - DRAFT shows correct Enterprise price');
    console.log('========================================\n');
  });

  it('should show all billing records to help debug DRAFT state', async () => {
    // Setup: schedule downgrade then upgrade
    await scheduleTierDowngrade(db, testCustomerId, 'seal', 'starter', clock);
    await handleTierUpgrade(db, testCustomerId, 'seal', 'enterprise', suiService, clock);

    // List ALL billing records
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
      console.log(`    id: ${record.id}`);
      console.log('    ---');
    }

    // Should have:
    // 1. DRAFT invoice for next month (Enterprise price)
    // 2. PENDING/PAID invoice for pro-rated upgrade charge
    const draftRecords = allRecords.filter(r => r.status === 'draft');
    expect(draftRecords.length).toBe(1);
    expect(draftRecords[0].amountUsdCents).toBe(TIER_PRICES_USD_CENTS.enterprise);

    console.log('\nDRAFT invoice is correct: $' + (draftRecords[0].amountUsdCents / 100).toFixed(2));
  });

  it('alternative scenario: cancel scheduled downgrade THEN upgrade', async () => {
    console.log('\n========================================');
    console.log('ALTERNATIVE: Cancel downgrade first, then upgrade');
    console.log('========================================\n');

    // Step 1: Schedule downgrade
    await scheduleTierDowngrade(db, testCustomerId, 'seal', 'starter', clock);

    let [service] = await db.select().from(serviceInstances).where(eq(serviceInstances.customerId, testCustomerId));
    expect(service.scheduledTier).toBe('starter');

    // Step 2: Cancel the scheduled downgrade
    console.log('Canceling scheduled downgrade...');
    const cancelResult = await cancelScheduledTierChange(db, testCustomerId, 'seal', clock);
    console.log(`  Cancel result: success=${cancelResult.success}`);
    expect(cancelResult.success).toBe(true);

    [service] = await db.select().from(serviceInstances).where(eq(serviceInstances.customerId, testCustomerId));
    console.log(`  After cancel: tier=${service.tier}, scheduledTier=${service.scheduledTier}`);
    expect(service.tier).toBe('pro');
    expect(service.scheduledTier).toBeNull();

    // Check DRAFT after cancel
    let [draft] = await db.select().from(billingRecords).where(and(
      eq(billingRecords.customerId, testCustomerId),
      eq(billingRecords.status, 'draft')
    ));
    console.log(`  DRAFT after cancel: ${draft?.amountUsdCents} cents (should be Pro = ${TIER_PRICES_USD_CENTS.pro})`);
    expect(draft.amountUsdCents).toBe(TIER_PRICES_USD_CENTS.pro);

    // Step 3: Now upgrade
    console.log('\nUpgrading to Enterprise...');
    const upgradeResult = await handleTierUpgrade(db, testCustomerId, 'seal', 'enterprise', suiService, clock);
    console.log(`  Upgrade result: success=${upgradeResult.success}`);
    expect(upgradeResult.success).toBe(true);

    [service] = await db.select().from(serviceInstances).where(eq(serviceInstances.customerId, testCustomerId));
    console.log(`  Final: tier=${service.tier}, scheduledTier=${service.scheduledTier}`);
    expect(service.tier).toBe('enterprise');

    [draft] = await db.select().from(billingRecords).where(and(
      eq(billingRecords.customerId, testCustomerId),
      eq(billingRecords.status, 'draft')
    ));
    console.log(`  Final DRAFT: ${draft?.amountUsdCents} cents (should be Enterprise = ${TIER_PRICES_USD_CENTS.enterprise})`);
    expect(draft.amountUsdCents).toBe(TIER_PRICES_USD_CENTS.enterprise);

    console.log('\n========================================');
    console.log('ALTERNATIVE SCENARIO PASSED');
    console.log('========================================\n');
  });
});
