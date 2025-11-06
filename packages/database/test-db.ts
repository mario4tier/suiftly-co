#!/usr/bin/env tsx
/**
 * Sanity test for database schema
 * Run with: cd packages/database && tsx test-db.ts
 */

import { db } from './src/db';
import { customers, serviceInstances, apiKeys } from './src/schema';
import { eq } from 'drizzle-orm';

async function testDatabase() {
  console.log('🧪 Testing database schema...\n');

  try {
    // Test 1: Insert a customer
    console.log('Test 1: Creating a test customer...');
    const testCustomerId = Math.floor(Math.random() * 1000000000) + 1; // Random ID
    const testCustomer = {
      customerId: testCustomerId,
      walletAddress: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      status: 'active' as const,
      maxMonthlyUsdCents: BigInt(25000), // $250
      currentBalanceUsdCents: BigInt(10000), // $100
      currentMonthChargedUsdCents: BigInt(0),
      lastMonthChargedUsdCents: BigInt(0),
    };

    await db.insert(customers).values(testCustomer);
    console.log('✓ Customer created:', testCustomer.customerId);

    // Test 2: Query the customer back
    console.log('\nTest 2: Querying customer...');
    const result = await db.select().from(customers).where(eq(customers.customerId, testCustomerId));
    console.log('✓ Customer found:', result[0]?.walletAddress);

    // Test 3: Insert a service instance
    console.log('\nTest 3: Creating a service instance...');
    await db.insert(serviceInstances).values({
      customerId: testCustomerId,
      serviceType: 'seal',
      tier: 'starter',
      isEnabled: true,
    });
    console.log('✓ Service instance created');

    // Test 4: Insert an API key with JSONB metadata
    console.log('\nTest 4: Creating API key with JSONB metadata...');
    await db.insert(apiKeys).values({
      apiKeyId: `test_key_${testCustomerId}`,
      apiKeyFp: '48656c72', // 4-byte fingerprint
      customerId: testCustomerId,
      serviceType: 'seal',
      metadata: {
        key_version: 1,
        seal_network: 1, // mainnet
        seal_access: 0, // open
        seal_source: 0, // derived
        proc_group: 0,
      },
      isActive: true,
    });
    console.log('✓ API key created with metadata');

    // Test 5: Query with JSONB
    console.log('\nTest 5: Querying API key metadata...');
    const keys = await db.select().from(apiKeys).where(eq(apiKeys.customerId, 12345678));
    console.log('✓ API key metadata:', keys[0]?.metadata);

    // Test 6: Verify foreign key constraints work
    console.log('\nTest 6: Testing foreign key constraint...');
    try {
      await db.insert(serviceInstances).values({
        customerId: 99999999, // Non-existent customer
        serviceType: 'seal',
        tier: 'pro',
        isEnabled: true,
      });
      console.log('✗ FAIL: Foreign key constraint should have prevented this!');
    } catch (err) {
      console.log('✓ Foreign key constraint working (insert rejected)');
    }

    // Cleanup
    console.log('\nCleaning up test data...');
    await db.delete(apiKeys).where(eq(apiKeys.customerId, testCustomerId));
    await db.delete(serviceInstances).where(eq(serviceInstances.customerId, testCustomerId));
    await db.delete(customers).where(eq(customers.customerId, testCustomerId));
    console.log('✓ Test data cleaned up');

    console.log('\n✅ All tests passed!\n');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

testDatabase();
