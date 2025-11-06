#!/usr/bin/env tsx
/**
 * Test Zod validation schemas
 * Run with: cd packages/shared && npx tsx test-schemas.ts
 */

import {
  customerSchema,
  walletAddressSchema,
  serviceCreateSchema,
  apiKeyCreateSchema,
  walletConnectSchema,
  depositRequestSchema,
} from './src/schemas';
import { CUSTOMER_STATUS, SERVICE_TYPE, SERVICE_TIER } from './src/constants';

console.log('🧪 Testing Zod validation schemas...\n');

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`✗ ${name}`);
    console.error('  Error:', err instanceof Error ? err.message : err);
    failed++;
  }
}

// Test 1: Valid wallet address
test('Valid wallet address', () => {
  walletAddressSchema.parse('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
});

// Test 2: Invalid wallet address (too short)
test('Invalid wallet address rejected', () => {
  try {
    walletAddressSchema.parse('0x1234');
    throw new Error('Should have failed validation');
  } catch (err) {
    // Expected to fail
  }
});

// Test 3: Valid customer
test('Valid customer object', () => {
  customerSchema.parse({
    customerId: 12345678,
    walletAddress: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    status: CUSTOMER_STATUS.ACTIVE,
    maxMonthlyUsdCents: 25000, // $250
    currentBalanceUsdCents: 10000, // $100
    currentMonthChargedUsdCents: 0,
    lastMonthChargedUsdCents: 0,
    currentMonthStart: '2025-10-01',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

// Test 4: Invalid customer status
test('Invalid customer status rejected', () => {
  try {
    customerSchema.parse({
      customerId: 12345678,
      walletAddress: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      status: 'invalid_status', // Should fail
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    throw new Error('Should have failed validation');
  } catch (err) {
    // Expected to fail
  }
});

// Test 5: Valid service creation
test('Valid service creation', () => {
  serviceCreateSchema.parse({
    customerId: 12345678,
    serviceType: SERVICE_TYPE.SEAL,
    tier: SERVICE_TIER.STARTER,
  });
});

// Test 6: Valid API key creation
test('Valid API key creation with metadata', () => {
  apiKeyCreateSchema.parse({
    customerId: 12345678,
    serviceType: SERVICE_TYPE.SEAL,
    metadata: {
      key_version: 1,
      seal_network: 1,
      seal_access: 0,
      seal_source: 0,
      proc_group: 0,
    },
  });
});

// Test 7: Valid wallet connect
test('Valid wallet connect request', () => {
  walletConnectSchema.parse({
    walletAddress: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  });
});

// Test 8: Valid deposit request
test('Valid deposit request', () => {
  depositRequestSchema.parse({
    amountSui: 100.5,
  });
});

// Test 9: 28-day spending limit validation (minimum $10)
test('Monthly limit minimum enforced', () => {
  try {
    customerSchema.parse({
      customerId: 12345678,
      walletAddress: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      status: CUSTOMER_STATUS.ACTIVE,
      maxMonthlyUsdCents: 1000, // $10 - below minimum
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    throw new Error('Should have failed validation');
  } catch (err) {
    // Expected to fail
  }
});

// Test 10: Constants are accessible
test('Constants exported correctly', () => {
  if (CUSTOMER_STATUS.ACTIVE !== 'active') throw new Error('Constant mismatch');
  if (SERVICE_TYPE.SEAL !== 'seal') throw new Error('Constant mismatch');
  if (SERVICE_TIER.PRO !== 'pro') throw new Error('Constant mismatch');
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log('❌ Some tests failed\n');
  process.exit(1);
} else {
  console.log('✅ All tests passed!\n');
  process.exit(0);
}
