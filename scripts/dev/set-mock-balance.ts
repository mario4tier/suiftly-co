#!/usr/bin/env tsx
/**
 * Set mock balance for test customers
 * Usage: tsx scripts/dev/set-mock-balance.ts [wallet-address] [amount-usd]
 */

import { db } from '@suiftly/database';
import { customers } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';

const MOCK_WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DEFAULT_BALANCE_USD = 1000;

async function setMockBalance() {
  const walletAddress = process.argv[2] || MOCK_WALLET;
  const balanceUsd = parseFloat(process.argv[3] || String(DEFAULT_BALANCE_USD));
  const balanceCents = Math.floor(balanceUsd * 100);

  console.log(`Setting balance for ${walletAddress}...`);
  console.log(`Amount: $${balanceUsd} (${balanceCents} cents)`);

  // Find customer
  const customer = await db.query.customers.findFirst({
    where: eq(customers.walletAddress, walletAddress),
  });

  if (!customer) {
    console.error(`❌ Customer not found with wallet: ${walletAddress}`);
    console.log('💡 Customer is created on first login');
    process.exit(1);
  }

  // Update balance
  await db
    .update(customers)
    .set({
      currentBalanceUsdCents: balanceCents,
      spendingLimitUsdCents: 25000, // $250 spending limit (28-day)
      currentPeriodChargedUsdCents: 0,
      currentPeriodStart: new Date().toISOString().split('T')[0],
    })
    .where(eq(customers.customerId, customer.customerId));

  console.log(`✅ Balance updated successfully`);
  console.log(`   Customer ID: ${customer.customerId}`);
  console.log(`   New balance: $${balanceUsd}`);
  console.log(`   28-day spending limit: $250`);

  process.exit(0);
}

setMockBalance().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
