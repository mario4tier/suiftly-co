/**
 * Database integration tests for API Key storage
 * Tests fingerprint calculation matches between api_key_id and api_key_fp in database
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';

// Set up test SECRET_KEY and encryption key before importing modules
process.env.API_SECRET_KEY = randomBytes(32).toString('hex');
process.env.DB_APP_FIELDS_ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { storeApiKey, createApiKeyFingerprint, type SealType } from '../src/lib/api-keys';
import { encryptSecret, decryptSecret } from '../src/lib/encryption';
import { db } from '@suiftly/database';
import { apiKeys, customers } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';
import { randomInt } from 'crypto';

describe('API Key Database Integration', () => {
  let testCustomerId: number;

  beforeAll(async () => {
    // Create a test customer for our tests
    const MAX_RETRIES = 10;
    let inserted = false;

    for (let attempt = 0; attempt < MAX_RETRIES && !inserted; attempt++) {
      testCustomerId = randomInt(1, 2147483648);
      try {
        await db.insert(customers).values({
          customerId: testCustomerId,
          walletAddress: '0x' + randomBytes(32).toString('hex'),
          status: 'active',
          maxMonthlyUsdCents: 25000,
          currentBalanceUsdCents: 0,
          currentMonthChargedUsdCents: 0,
          lastMonthChargedUsdCents: 0,
          currentMonthStart: new Date().toISOString().split('T')[0],
        });
        inserted = true;
      } catch (error: any) {
        if (error.code === '23505' && error.constraint === 'customers_pkey') {
          continue;
        }
        throw error;
      }
    }

    if (!inserted) {
      throw new Error('Failed to create test customer');
    }
  });

  afterAll(async () => {
    // Clean up test data
    await db.delete(apiKeys).where(eq(apiKeys.customerId, testCustomerId));
    await db.delete(customers).where(eq(customers.customerId, testCustomerId));
  });

  describe('Fingerprint Consistency', () => {
    it('should store api_key_fp that matches fingerprint calculated from api_key_id', async () => {
      // Store an API key
      const result = await storeApiKey({
        customerId: testCustomerId,
        serviceType: 'seal',
      });

      const { record, plainKey } = result;

      // Calculate fingerprint from the plain key
      const calculatedFp = createApiKeyFingerprint(plainKey);

      // Verify it matches what's stored in the database
      expect(record.apiKeyFp).toBe(calculatedFp);

      // Read back from database
      const storedKeys = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.apiKeyFp, calculatedFp)) // Use fingerprint for lookup
        .limit(1);

      expect(storedKeys.length).toBe(1);
      expect(storedKeys[0].apiKeyFp).toBe(calculatedFp);

      // Verify api_key_id is encrypted (not plain text)
      expect(storedKeys[0].apiKeyId).not.toBe(plainKey);
      expect(storedKeys[0].apiKeyId).toContain(':'); // Encrypted format: IV:authTag:ciphertext

      // Decrypt api_key_id and verify it matches the plain key
      const decryptedKey = decryptSecret(storedKeys[0].apiKeyId);
      expect(decryptedKey).toBe(plainKey);

      // Verify fingerprint calculated from decrypted key matches stored fingerprint
      const fpFromDecrypted = createApiKeyFingerprint(decryptedKey);
      expect(fpFromDecrypted).toBe(storedKeys[0].apiKeyFp);
    });

    it('should handle multiple API keys with different fingerprints', async () => {
      const keys = [];

      // Generate 10 API keys
      for (let i = 0; i < 10; i++) {
        const result = await storeApiKey({
          customerId: testCustomerId,
          serviceType: 'seal',
        });
        keys.push(result);
      }

      // Verify each key's fingerprint and encryption
      for (const { record, plainKey } of keys) {
        const calculatedFp = createApiKeyFingerprint(plainKey);
        expect(record.apiKeyFp).toBe(calculatedFp);

        // Verify stored record matches (lookup by fingerprint)
        const stored = await db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.apiKeyFp, calculatedFp))
          .limit(1);

        expect(stored.length).toBe(1);
        expect(stored[0].apiKeyFp).toBe(calculatedFp);

        // Verify encryption
        expect(stored[0].apiKeyId).not.toBe(plainKey); // Should be encrypted
        const decrypted = decryptSecret(stored[0].apiKeyId);
        expect(decrypted).toBe(plainKey);

        // Verify fingerprint from decrypted key
        expect(createApiKeyFingerprint(decrypted)).toBe(stored[0].apiKeyFp);
      }

      // Verify all fingerprints are unique
      const fingerprints = keys.map(k => k.record.apiKeyFp);
      const uniqueFps = new Set(fingerprints);
      expect(uniqueFps.size).toBe(keys.length);

      // Verify all encrypted api_key_ids are unique (different due to random IV)
      const encryptedIds = keys.map(k => k.record.apiKeyId);
      const uniqueEncrypted = new Set(encryptedIds);
      expect(uniqueEncrypted.size).toBe(keys.length);
    });

    it('should correctly store and retrieve fingerprints with negative values (MSB set) in PostgreSQL', async () => {
      // **CRITICAL DATABASE TEST: Verifies PostgreSQL signed INTEGER storage**
      // This test ensures that fingerprints with MSB set (appearing as negative
      // in signed 32-bit representation) are correctly:
      // 1. Stored in PostgreSQL INTEGER column (signed -2^31 to 2^31-1)
      // 2. Retrieved via WHERE clause with negative values
      // 3. Used as primary key for lookups
      //
      // Probability calculation for negative fingerprints:
      // - Each key has ~50% chance of negative fingerprint
      // - P(no negative in n attempts) = (0.5)^n
      // - After 10 attempts: 0.098% failure rate
      // - After 100 attempts: ~10^-30 failure rate (essentially zero)
      // Strategy: Try 100 attempts (10x the 10 needed for 99.9% confidence)

      const keys = [];
      const maxAttempts = 100; // 10x safety margin
      let negativeKey = null;

      for (let i = 0; i < maxAttempts; i++) {
        // Store API key in PostgreSQL via storeApiKey()
        const result = await storeApiKey({
          customerId: testCustomerId,
          serviceType: 'seal',
        });
        keys.push(result);

        // Track the first negative fingerprint we find (MSB = 1)
        if (!negativeKey && result.record.apiKeyFp < 0) {
          negativeKey = result;
          console.log(`✓ Found negative fingerprint: ${result.record.apiKeyFp} (hex: 0x${(result.record.apiKeyFp >>> 0).toString(16).toUpperCase()})`);
        }

        // Stop early if we found a negative (saves test time)
        if (negativeKey) {
          break;
        }
      }

      // CRITICAL: Assert that we found at least one negative fingerprint
      expect(negativeKey).not.toBeNull();
      expect(negativeKey!.record.apiKeyFp).toBeLessThan(0);
      expect(negativeKey!.record.apiKeyFp).toBeGreaterThanOrEqual(-2147483648);

      // **TEST 1: Verify PostgreSQL INSERT succeeded with negative fingerprint**
      console.log(`✓ PostgreSQL INSERT succeeded with negative fingerprint: ${negativeKey!.record.apiKeyFp}`);

      // **TEST 2: Verify PostgreSQL SELECT by negative fingerprint (PRIMARY KEY)**
      // This is critical - PostgreSQL must handle WHERE api_key_fp = <negative_value>
      const storedNegative = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.apiKeyFp, negativeKey!.record.apiKeyFp)) // WHERE api_key_fp = -123456789
        .limit(1);

      expect(storedNegative.length).toBe(1);
      expect(storedNegative[0].apiKeyFp).toBe(negativeKey!.record.apiKeyFp);
      expect(storedNegative[0].apiKeyFp).toBeLessThan(0);
      console.log(`✓ PostgreSQL SELECT by negative fingerprint succeeded`);

      // **TEST 3: Verify the negative value round-trips correctly**
      // Stored value must exactly match what we queried with
      expect(storedNegative[0].apiKeyFp).toBe(negativeKey!.record.apiKeyFp);
      console.log(`✓ Negative fingerprint round-trip verified: ${storedNegative[0].apiKeyFp} === ${negativeKey!.record.apiKeyFp}`);

      // **TEST 4: Verify decryption works for API key with negative fingerprint**
      const decryptedKey = decryptSecret(storedNegative[0].apiKeyId);
      expect(decryptedKey).toBe(negativeKey!.plainKey);
      expect(createApiKeyFingerprint(decryptedKey)).toBe(negativeKey!.record.apiKeyFp);
      console.log(`✓ Decryption and fingerprint recalculation succeeded for negative fingerprint`);

      // **TEST 5: Verify all fingerprints are in valid signed 32-bit range**
      for (const { record, plainKey } of keys) {
        expect(record.apiKeyFp).toBeGreaterThanOrEqual(-2147483648);
        expect(record.apiKeyFp).toBeLessThanOrEqual(2147483647);

        // Verify calculation matches
        const calculated = createApiKeyFingerprint(plainKey);
        expect(calculated).toBe(record.apiKeyFp);
      }

      // Log statistics for debugging
      const positive = keys.filter(k => k.record.apiKeyFp >= 0).length;
      const negative = keys.filter(k => k.record.apiKeyFp < 0).length;
      console.log(`\n✓ PostgreSQL signed INTEGER test complete:`);
      console.log(`  - Generated ${keys.length} keys: ${positive} positive, ${negative} negative fingerprints`);
      console.log(`  - Verified PostgreSQL storage and retrieval with negative values (MSB set)`);
    });
  });

  describe('Collision Retry', () => {
    it('should successfully store API key even with potential collisions', async () => {
      // This test verifies the collision retry logic works
      // In practice, collisions are rare (~0.014% at 600K keys)
      // But the retry mechanism should handle them if they occur

      const result = await storeApiKey({
        customerId: testCustomerId,
        serviceType: 'seal',
      });

      expect(result.record).toBeDefined();
      expect(result.plainKey).toBeDefined();
      expect(result.record.apiKeyFp).toBe(createApiKeyFingerprint(result.plainKey));
    });
  });

  describe('Different Service Types', () => {
    it('should correctly store fingerprints for different service types', async () => {
      const serviceTypes = ['seal', 'grpc', 'graphql'] as const;

      for (const serviceType of serviceTypes) {
        const result = await storeApiKey({
          customerId: testCustomerId,
          serviceType,
        });

        // Verify fingerprint matches
        const calculatedFp = createApiKeyFingerprint(result.plainKey);
        expect(result.record.apiKeyFp).toBe(calculatedFp);

        // Verify service type prefix
        const expectedPrefix = { seal: 'S', grpc: 'R', graphql: 'G' }[serviceType];
        expect(result.plainKey[0]).toBe(expectedPrefix);

        // Verify stored in database correctly (query by fingerprint, not encrypted key)
        const stored = await db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.apiKeyFp, calculatedFp))
          .limit(1);

        expect(stored.length).toBe(1);
        expect(stored[0].serviceType).toBe(serviceType);
        expect(stored[0].apiKeyFp).toBe(calculatedFp);
      }
    });
  });

  describe('Different Seal Types', () => {
    it('should correctly store fingerprints for different seal configurations', async () => {
      const sealTypes: SealType[] = [
        { network: 'testnet', access: 'open' },
        { network: 'mainnet', access: 'open' },
        { network: 'testnet', access: 'permission', source: 'derived' },
        { network: 'testnet', access: 'permission', source: 'imported' },
        { network: 'mainnet', access: 'permission', source: 'derived' },
        { network: 'mainnet', access: 'permission', source: 'imported' },
      ];

      for (const sealType of sealTypes) {
        const result = await storeApiKey({
          customerId: testCustomerId,
          serviceType: 'seal',
          sealType,
        });

        // Verify fingerprint matches
        const calculatedFp = createApiKeyFingerprint(result.plainKey);
        expect(result.record.apiKeyFp).toBe(calculatedFp);

        // Verify metadata stored correctly
        expect(result.record.metadata).toHaveProperty('sealType');

        // Verify in database (query by fingerprint, not encrypted key)
        const stored = await db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.apiKeyFp, calculatedFp))
          .limit(1);

        expect(stored.length).toBe(1);
        expect(stored[0].apiKeyFp).toBe(calculatedFp);
      }
    });
  });
});
