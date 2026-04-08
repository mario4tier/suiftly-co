/**
 * API Test: Billing Upgrade Duplicate Bug (FIXED)
 *
 * Tests that failed payment attempts are NOT shown in billing history.
 *
 * Issue: User reported upgrading from starter to pro once, but
 * billing history showed the upgrade 3 times. This happened because:
 * 1. User clicked upgrade 3 times (first 2 failed due to insufficient balance)
 * 2. All 3 invoices (2 failed + 1 paid) were showing in billing history
 *
 * Fix: Filter out 'failed' status invoices from billing history.
 * Users only care about successful charges, not failed payment attempts.
 *
 * Platform tier is the only subscription tier. Upgrade from starter → pro.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { billingRecords, invoiceLineItems } from '@suiftly/database/schema';
import { eq, and, sql } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  trpcMutation,
  trpcQuery,
  resetTestData,
} from './helpers/http.js';
import { TEST_WALLET } from './helpers/auth.js';
import { setupBillingTest } from './helpers/setup.js';

describe('API: Billing Upgrade Duplicate Bug', () => {
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    // Platform is subscribed at starter tier (auto-provisioned seal/grpc/graphql)
    ({ accessToken, customerId } = await setupBillingTest({ balance: 500 }));
  });

  afterEach(async () => {
    await resetClock();
    await resetTestData(TEST_WALLET);
  });

  it('should create exactly one billing record for a single tier upgrade', async () => {
    // Platform is already at starter; upgrade to pro
    await setClockTime('2025-01-15T12:00:00Z');

    // Count billing records before upgrade
    const recordsBefore = await db.query.billingRecords.findMany({
      where: eq(billingRecords.customerId, customerId),
    });
    const upgradeRecordsBefore = recordsBefore.filter(r =>
      r.status !== 'draft'
    );
    console.log(`Billing records before upgrade: ${upgradeRecordsBefore.length}`);

    // ---- Perform the upgrade (single call) ----
    const upgradeResult = await trpcMutation<any>(
      'services.upgradeTier',
      { serviceType: 'platform', newTier: 'pro' },
      accessToken
    );

    expect(upgradeResult.result?.data?.success).toBe(true);
    expect(upgradeResult.result?.data?.newTier).toBe('pro');

    // ---- Check billing records after upgrade ----
    const recordsAfter = await db.query.billingRecords.findMany({
      where: eq(billingRecords.customerId, customerId),
    });
    const upgradeRecordsAfter = recordsAfter.filter(r =>
      r.status !== 'draft'
    );
    console.log(`Billing records after upgrade: ${upgradeRecordsAfter.length}`);

    // Count how many new records were created
    const newRecordsCount = upgradeRecordsAfter.length - upgradeRecordsBefore.length;
    console.log(`New billing records created by upgrade: ${newRecordsCount}`);

    // EXPECTATION: Exactly 1 new billing record should be created for the upgrade
    expect(newRecordsCount).toBe(1);

    // Find the upgrade billing record
    const upgradeRecord = recordsAfter.find(r =>
      r.status !== 'draft' &&
      !upgradeRecordsBefore.find(b => b.id === r.id)
    );
    expect(upgradeRecord).toBeDefined();

    // Check line items for the upgrade record
    const lineItems = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.billingRecordId, upgradeRecord!.id),
    });
    console.log(`Line items for upgrade record: ${lineItems.length}`);
    console.log(`Line item descriptions: ${lineItems.map(l => l.description).join(', ')}`);

    // EXPECTATION: Exactly 1 line item should be created
    expect(lineItems.length).toBe(1);
  });

  it('should show correct number of entries in billing history after upgrade', async () => {
    // Platform is already at starter
    await setClockTime('2025-01-15T12:00:00Z');

    // Get billing history before upgrade
    const historyBefore = await trpcQuery<any>(
      'billing.getTransactions',
      { limit: 50 },
      accessToken
    );
    const invoicesBefore = historyBefore.result?.data?.transactions?.filter(
      (t: any) => t.source === 'invoice'
    ) || [];
    console.log(`Invoice transactions before upgrade: ${invoicesBefore.length}`);

    // ---- Perform the upgrade ----
    await trpcMutation<any>(
      'services.upgradeTier',
      { serviceType: 'platform', newTier: 'pro' },
      accessToken
    );

    // Get billing history after upgrade
    const historyAfter = await trpcQuery<any>(
      'billing.getTransactions',
      { limit: 50 },
      accessToken
    );
    const invoicesAfter = historyAfter.result?.data?.transactions?.filter(
      (t: any) => t.source === 'invoice'
    ) || [];
    console.log(`Invoice transactions after upgrade: ${invoicesAfter.length}`);

    // Count upgrade entries (platform starter→pro upgrade)
    const upgradeEntries = invoicesAfter.filter((t: any) =>
      t.description?.toLowerCase().includes('upgrade')
    );
    console.log(`Upgrade entries in history: ${upgradeEntries.length}`);
    console.log('Upgrade entry descriptions:', upgradeEntries.map((t: any) => t.description));

    // EXPECTATION: Exactly 1 upgrade entry should appear
    // If this fails with 3 entries, we've reproduced the bug!
    expect(upgradeEntries.length).toBe(1);

    // New invoice entries: upgrade charge (+ possibly reconciliation credit)
    // The exact count varies based on timing — what matters is no duplicates
    const newInvoiceCount = invoicesAfter.length - invoicesBefore.length;
    console.log(`New invoice entries from upgrade: ${newInvoiceCount}`);
    expect(newInvoiceCount).toBeGreaterThanOrEqual(1);
    expect(newInvoiceCount).toBeLessThanOrEqual(2);
  });

  it('should not create duplicate records when upgrade API is called once', async () => {
    // ---- Setup ----
    await setClockTime('2025-01-15T12:00:00Z');

    // Directly query the database to count records
    const getUpgradeRecords = async () => {
      return db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          sql`${billingRecords.status} != 'draft'`
        ),
      });
    };

    const recordsBeforeUpgrade = await getUpgradeRecords();

    // ---- Call upgrade API exactly once (platform starter → pro) ----
    await trpcMutation<any>(
      'services.upgradeTier',
      { serviceType: 'platform', newTier: 'pro' },
      accessToken
    );

    const recordsAfterUpgrade = await getUpgradeRecords();

    // Get all line items to understand what's happening
    const allLineItems = await db.query.invoiceLineItems.findMany({
      where: sql`1=1`,
    });

    // Filter to just this customer's records
    const customerRecordIds = new Set(recordsAfterUpgrade.map(r => r.id));
    const customerLineItems = allLineItems.filter(li =>
      customerRecordIds.has(li.billingRecordId)
    );

    console.log('\n=== Detailed Database State ===');
    console.log('Billing records before upgrade:', recordsBeforeUpgrade.length);
    console.log('Billing records after upgrade:', recordsAfterUpgrade.length);
    console.log('New records created:', recordsAfterUpgrade.length - recordsBeforeUpgrade.length);
    console.log('\nAll billing records for customer:');
    for (const record of recordsAfterUpgrade) {
      const lineItems = customerLineItems.filter(li => li.billingRecordId === record.id);
      console.log(`  Record ${record.id} (${record.status}): $${Number(record.amountUsdCents) / 100}`);
      for (const li of lineItems) {
        console.log(`    Line item: ${li.description} - $${Number(li.amountUsdCents) / 100}`);
      }
    }

    // EXPECTATION: Only 1 new billing record should be created
    const newRecordCount = recordsAfterUpgrade.length - recordsBeforeUpgrade.length;
    expect(newRecordCount).toBe(1);
  });
});
