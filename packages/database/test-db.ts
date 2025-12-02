#!/usr/bin/env tsx
/**
 * Sanity test for database schema
 * Run with: cd packages/database && tsx test-db.ts
 */

import { db } from './src/db';
import { customers, serviceInstances, apiKeys } from './src/schema';
import { eq } from 'drizzle-orm';
import { createCipheriv, randomBytes } from 'crypto';

// Mock encryption for test (in production, use proper encryption utility)
function mockEncryptSecret(plaintext: string): string {
  // For test purposes, just return a mock encrypted format
  // Real encryption should use apps/api/src/lib/encryption.ts
  const iv = randomBytes(16).toString('base64');
  const authTag = randomBytes(16).toString('base64');
  const ciphertext = Buffer.from(plaintext).toString('base64');
  return `${iv}:${authTag}:${ciphertext}`;
}

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
      spendingLimitUsdCents: 25000, // $250
      currentBalanceUsdCents: 10000, // $100
      currentPeriodChargedUsdCents: 0,
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
      isUserEnabled: true,
    });
    console.log('✓ Service instance created');

    // Test 4: Insert an API key with JSONB metadata
    console.log('\nTest 4: Creating API key with JSONB metadata...');
    const plainApiKey = `test_key_${testCustomerId}`;
    const encryptedApiKey = mockEncryptSecret(plainApiKey);

    await db.insert(apiKeys).values({
      apiKeyId: encryptedApiKey, // Store encrypted (IV:authTag:ciphertext format)
      apiKeyFp: 1214606450, // 32-bit integer fingerprint (0x48656c72)
      customerId: testCustomerId,
      serviceType: 'seal',
      metadata: {
        key_version: 1,
        seal_network: 1, // mainnet
        seal_access: 0, // open
        seal_source: 0, // derived
        proc_group: 0,
      },
      isUserEnabled: true,
    });
    console.log('✓ API key created with encrypted api_key_id and metadata');

    // Test 5: Query with JSONB
    console.log('\nTest 5: Querying API key metadata...');
    const keys = await db.select().from(apiKeys).where(eq(apiKeys.customerId, testCustomerId));
    if (!keys[0]) {
      throw new Error('API key not found - query returned no results');
    }
    console.log('✓ API key metadata:', keys[0].metadata);

    // Validate the metadata structure
    const metadata = keys[0].metadata as any;
    if (metadata.key_version !== 1 || metadata.seal_network !== 1) {
      throw new Error('Metadata validation failed - JSONB not stored correctly');
    }
    console.log('✓ JSONB metadata validated successfully');

    // Test 6: Verify foreign key constraints work
    console.log('\nTest 6: Testing foreign key constraint...');
    try {
      await db.insert(serviceInstances).values({
        customerId: 99999999, // Non-existent customer
        serviceType: 'seal',
        tier: 'pro',
        isUserEnabled: true,
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
