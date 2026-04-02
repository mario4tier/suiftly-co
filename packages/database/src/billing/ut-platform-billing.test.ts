/**
 * Platform Billing Tests (Phase 4)
 *
 * Partial test matrix: freq_platform_sub=1, freq_seal_sub=0
 * This is the production MVP path: platform subscription required, per-service sub disabled.
 *
 * Tests:
 * - Platform subscribe (starter $1, pro $29)
 * - Platform tier upgrade/downgrade
 * - Platform + seal: DRAFT invoice shows only platform subscription
 * - Platform cancellation removes from DRAFT
 * - Platform pricing is service-type-aware (not $9/$29/$185)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { db } from '../db';
import {
  customers,
  billingRecords,
  invoiceLineItems,
  serviceInstances,
} from '../schema';
import { MockDBClock } from '@suiftly/shared/db-clock';
import type { ISuiService, ChargeParams, TransactionResult } from '@suiftly/shared/sui-service';
import {
  handleSubscriptionBilling,
  recalculateDraftInvoice,
} from './service-billing';
import {
  handleTierUpgrade,
  scheduleTierDowngrade,
  scheduleCancellation,
  undoCancellation,
  getTierChangeOptions,
} from './tier-changes';
import {
  toPaymentServices,
  ensureEscrowPaymentMethod,
  cleanupCustomerData,
  resetTestState,
  suspendGMProcessing,
} from './test-helpers';
import { eq, and } from 'drizzle-orm';
import { getTierPriceUsdCents, getAvailableTiers } from '@suiftly/shared/pricing';

// Mock SUI service
class TestMockSuiService implements ISuiService {
  private generateMockDigest(): string {
    const bytes = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
    return '0x' + bytes.toString('hex');
  }

  async charge(params: ChargeParams): Promise<TransactionResult> {
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, params.userAddress),
    });
    if (!customer) return { digest: this.generateMockDigest(), success: false, error: 'Customer not found' };
    const currentBalance = customer.currentBalanceUsdCents ?? 0;
    if (currentBalance < params.amountUsdCents) {
      return { digest: this.generateMockDigest(), success: false, error: 'Insufficient balance' };
    }
    await db.update(customers)
      .set({ currentBalanceUsdCents: currentBalance - params.amountUsdCents })
      .where(eq(customers.customerId, customer.customerId));
    return { digest: this.generateMockDigest(), success: true, checkpoint: Date.now() };
  }

  async getAccount() { return null; }
  async syncAccount() { return null; }
  async deposit() { return { digest: '0x', success: true }; }
  async withdraw() { return { digest: '0x', success: true }; }
  async credit() { return { digest: '0x', success: true }; }
  async updateSpendingLimit() { return { digest: '0x', success: true }; }
  async buildTransaction() { return null; }
  isMock() { return true; }
  async getTransactionHistory() { return []; }
}

// Helper to create a service instance and subscribe
async function subscribeToService(
  customerId: number,
  serviceType: 'platform' | 'seal',
  tier: string,
  paymentServices: ReturnType<typeof toPaymentServices>,
  clock: MockDBClock,
) {
  await db.insert(serviceInstances).values({
    customerId,
    serviceType,
    tier,
    state: serviceType === 'platform' ? 'enabled' : 'disabled',
    isUserEnabled: serviceType === 'platform',
    paidOnce: false,
    config: { tier },
  });

  return handleSubscriptionBilling(
    db, customerId, serviceType, tier,
    getTierPriceUsdCents(tier, serviceType),
    paymentServices, clock,
  );
}

// Helper to get DRAFT invoice and its line items
async function getDraftWithLineItems(customerId: number) {
  const draft = await db.query.billingRecords.findFirst({
    where: and(
      eq(billingRecords.customerId, customerId),
      eq(billingRecords.status, 'draft'),
    ),
  });
  if (!draft) return { draft: null, lineItems: [] };
  const lineItems = await db.select().from(invoiceLineItems)
    .where(eq(invoiceLineItems.billingRecordId, draft.id));
  return { draft, lineItems };
}

describe('Platform Billing (partial: platform=1, seal_sub=0)', () => {
  const clock = new MockDBClock();
  const suiService = new TestMockSuiService();
  const paymentServices = toPaymentServices(suiService);
  const CUSTOMER_ID = 8900;
  const WALLET = '0xPLATFORM8900abcdef1234567890abcdefABCDEF1234567890abcdefABCD';

  beforeAll(async () => {
    await resetTestState(db);
  });

  beforeEach(async () => {
    await suspendGMProcessing();
    clock.setTime(new Date('2025-01-15T00:00:00Z'));
    await cleanupCustomerData(db, CUSTOMER_ID);

    await db.insert(customers).values({
      customerId: CUSTOMER_ID,
      walletAddress: WALLET,
      escrowContractId: '0xESCROW8900',
      status: 'active',
      currentBalanceUsdCents: 100000, // $1000
      spendingLimitUsdCents: 200000,
      currentPeriodChargedUsdCents: 0,
      currentPeriodStart: '2025-01-01',
      paidOnce: false,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });

    await ensureEscrowPaymentMethod(db, CUSTOMER_ID);
  });

  afterEach(async () => {
    await cleanupCustomerData(db, CUSTOMER_ID);
  });

  // ===========================================================================
  // Pricing
  // ===========================================================================

  describe('Platform Pricing', () => {
    it('should return correct prices for platform tiers', () => {
      expect(getTierPriceUsdCents('starter', 'platform')).toBe(100);  // $1
      expect(getTierPriceUsdCents('pro', 'platform')).toBe(2900);     // $29
    });

    it('should reject enterprise tier for platform', () => {
      expect(() => getTierPriceUsdCents('enterprise', 'platform')).toThrow();
    });

    it('should return only starter and pro for platform available tiers', () => {
      expect(getAvailableTiers('platform')).toEqual(['starter', 'pro']);
    });

    it('should not affect per-service pricing', () => {
      expect(getTierPriceUsdCents('starter', 'seal')).toBe(900);     // $9
      expect(getTierPriceUsdCents('pro', 'seal')).toBe(2900);        // $29
      expect(getTierPriceUsdCents('enterprise', 'seal')).toBe(18500); // $185
    });
  });

  // ===========================================================================
  // Subscribe
  // ===========================================================================

  describe('Platform Subscribe', () => {
    it('should charge $1 for platform starter', async () => {
      const result = await subscribeToService(CUSTOMER_ID, 'platform', 'starter', paymentServices, clock);
      expect(result.paymentSuccessful).toBe(true);
      expect(result.amountUsdCents).toBe(100);
    });

    it('should charge $29 for platform pro', async () => {
      const result = await subscribeToService(CUSTOMER_ID, 'platform', 'pro', paymentServices, clock);
      expect(result.paymentSuccessful).toBe(true);
      expect(result.amountUsdCents).toBe(2900);
    });

    it('should set paidOnce on both service and customer after payment', async () => {
      await subscribeToService(CUSTOMER_ID, 'platform', 'starter', paymentServices, clock);

      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, CUSTOMER_ID),
          eq(serviceInstances.serviceType, 'platform'),
        ),
      });
      expect(service?.paidOnce).toBe(true);

      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, CUSTOMER_ID),
      });
      expect(customer?.paidOnce).toBe(true);
    });
  });

  // ===========================================================================
  // DRAFT Invoice
  // ===========================================================================

  describe('DRAFT Invoice', () => {
    it('should include platform subscription at correct price in DRAFT', async () => {
      await subscribeToService(CUSTOMER_ID, 'platform', 'starter', paymentServices, clock);

      const { draft, lineItems } = await getDraftWithLineItems(CUSTOMER_ID);
      expect(draft).toBeDefined();

      const platformItem = lineItems.find(li => li.serviceType === 'platform');
      expect(platformItem).toBeDefined();
      expect(Number(platformItem!.amountUsdCents)).toBe(100); // $1
    });

    it('should show platform + seal combined in DRAFT when both subscribed', async () => {
      // Subscribe to platform starter ($1)
      await subscribeToService(CUSTOMER_ID, 'platform', 'starter', paymentServices, clock);
      // Subscribe to seal pro ($29)
      await subscribeToService(CUSTOMER_ID, 'seal', 'pro', paymentServices, clock);

      const { draft, lineItems } = await getDraftWithLineItems(CUSTOMER_ID);
      expect(draft).toBeDefined();

      const platformItem = lineItems.find(li => li.serviceType === 'platform');
      const sealItem = lineItems.find(li => li.serviceType === 'seal');
      expect(platformItem).toBeDefined();
      expect(sealItem).toBeDefined();
      expect(Number(platformItem!.amountUsdCents)).toBe(100);  // $1
      expect(Number(sealItem!.amountUsdCents)).toBe(2900);     // $29
      expect(Number(draft!.amountUsdCents)).toBe(3000);         // $30 total
    });

    it('should not include usage line item for platform ($0 pricing)', async () => {
      await subscribeToService(CUSTOMER_ID, 'platform', 'starter', paymentServices, clock);

      const { lineItems } = await getDraftWithLineItems(CUSTOMER_ID);
      const usageItem = lineItems.find(li =>
        li.serviceType === 'platform' && li.itemType === 'requests'
      );
      expect(usageItem).toBeUndefined();
    });
  });

  // ===========================================================================
  // Tier Changes
  // ===========================================================================

  describe('Platform Tier Changes', () => {
    it('should show only starter and pro in tier change options', async () => {
      await subscribeToService(CUSTOMER_ID, 'platform', 'starter', paymentServices, clock);

      const options = await getTierChangeOptions(db, CUSTOMER_ID, 'platform', clock);
      expect(options).not.toBeNull();

      const tierNames = options!.availableTiers.map(t => t.tier);
      expect(tierNames).toEqual(['starter', 'pro']);
      expect(tierNames).not.toContain('enterprise');
    });

    it('should upgrade platform starter to pro with pro-rated charge', async () => {
      await subscribeToService(CUSTOMER_ID, 'platform', 'starter', paymentServices, clock);

      const result = await handleTierUpgrade(
        db, CUSTOMER_ID, 'platform', 'pro', paymentServices, clock
      );

      expect(result.success).toBe(true);
      // Pro-rated: ($29 - $1) * 17/31 = $15.35 → 1535 cents
      expect(result.chargeAmountUsdCents).toBe(Math.floor((2900 - 100) * 17 / 31));

      // Verify service tier changed
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, CUSTOMER_ID),
          eq(serviceInstances.serviceType, 'platform'),
        ),
      });
      expect(service?.tier).toBe('pro');
    });

    it('should schedule platform pro to starter downgrade for 1st of next month', async () => {
      await subscribeToService(CUSTOMER_ID, 'platform', 'pro', paymentServices, clock);

      const result = await scheduleTierDowngrade(
        db, CUSTOMER_ID, 'platform', 'starter', clock
      );

      expect(result.success).toBe(true);

      // Verify scheduled tier
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, CUSTOMER_ID),
          eq(serviceInstances.serviceType, 'platform'),
        ),
      });
      expect(service?.tier).toBe('pro'); // Still pro until effective date
      expect(service?.scheduledTier).toBe('starter');

      // DRAFT should reflect the scheduled downgrade price
      const { draft } = await getDraftWithLineItems(CUSTOMER_ID);
      expect(Number(draft!.amountUsdCents)).toBe(100); // $1 (starter price for next month)
    });
  });

  // ===========================================================================
  // Cancellation
  // ===========================================================================

  describe('Platform Cancellation', () => {
    it('should remove platform from DRAFT after cancellation', async () => {
      await subscribeToService(CUSTOMER_ID, 'platform', 'starter', paymentServices, clock);

      const cancelResult = await scheduleCancellation(db, CUSTOMER_ID, 'platform', clock);
      expect(cancelResult.success).toBe(true);

      const { draft, lineItems } = await getDraftWithLineItems(CUSTOMER_ID);
      const platformItem = lineItems.find(li => li.serviceType === 'platform');
      expect(platformItem).toBeUndefined();
      expect(Number(draft!.amountUsdCents)).toBe(0);
    });

    it('should restore platform to DRAFT after undo cancellation', async () => {
      await subscribeToService(CUSTOMER_ID, 'platform', 'starter', paymentServices, clock);
      await scheduleCancellation(db, CUSTOMER_ID, 'platform', clock);

      // Undo
      const undoResult = await undoCancellation(db, CUSTOMER_ID, 'platform', clock);
      expect(undoResult.success).toBe(true);

      const { draft, lineItems } = await getDraftWithLineItems(CUSTOMER_ID);
      const platformItem = lineItems.find(li => li.serviceType === 'platform');
      expect(platformItem).toBeDefined();
      expect(Number(platformItem!.amountUsdCents)).toBe(100); // $1 restored
    });

    it('should not affect seal subscription when platform is cancelled', async () => {
      // Subscribe to both
      await subscribeToService(CUSTOMER_ID, 'platform', 'starter', paymentServices, clock);
      await subscribeToService(CUSTOMER_ID, 'seal', 'pro', paymentServices, clock);

      // Cancel only platform
      await scheduleCancellation(db, CUSTOMER_ID, 'platform', clock);

      // Seal should still be in DB and on the DRAFT
      const seal = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, CUSTOMER_ID),
          eq(serviceInstances.serviceType, 'seal'),
        ),
      });
      expect(seal).toBeDefined();
      expect(seal!.cancellationScheduledFor).toBeNull();

      const { lineItems } = await getDraftWithLineItems(CUSTOMER_ID);
      const sealItem = lineItems.find(li => li.serviceType === 'seal');
      expect(sealItem).toBeDefined();
      expect(Number(sealItem!.amountUsdCents)).toBe(2900); // $29 unchanged
    });
  });
});
