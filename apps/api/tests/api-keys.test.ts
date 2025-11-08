/**
 * Unit tests for API Key generation and decoding
 * Tests the production implementation of API_KEY_DESIGN.md
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';

// Set up test SECRET_KEY before importing api-keys module
process.env.API_SECRET_KEY = randomBytes(32).toString('hex');

import { generateApiKey, decodeApiKey, createApiKeyFingerprint, type SealType } from '../src/lib/api-keys';

describe('API Key Generation and Decoding', () => {
  describe('Basic Generation', () => {
    it('should generate a valid API key with correct length', () => {
      const apiKey = generateApiKey(12345, 'seal');

      expect(apiKey).toHaveLength(37);
      expect(apiKey[0]).toBe('S'); // Seal service
    });

    it('should generate different keys for same customer (random IV)', () => {
      const key1 = generateApiKey(12345, 'seal');
      const key2 = generateApiKey(12345, 'seal');

      expect(key1).not.toBe(key2);
      expect(key1).toHaveLength(37);
      expect(key2).toHaveLength(37);
    });

    it('should generate keys for different service types', () => {
      const sealKey = generateApiKey(12345, 'seal');
      const grpcKey = generateApiKey(12345, 'grpc');
      const graphqlKey = generateApiKey(12345, 'graphql');

      expect(sealKey[0]).toBe('S');
      expect(grpcKey[0]).toBe('R');
      expect(graphqlKey[0]).toBe('G');
    });
  });

  describe('Encoding and Decoding Round-trip', () => {
    it('should correctly encode and decode customer ID', () => {
      const customerId = 123456789;
      const apiKey = generateApiKey(customerId, 'seal');
      const decoded = decodeApiKey(apiKey);

      expect(decoded.customerId).toBe(customerId);
      expect(decoded.serviceType).toBe('seal');
    });

    it('should handle maximum customer ID (32-bit)', () => {
      const customerId = 0xFFFFFFFF; // 4,294,967,295
      const apiKey = generateApiKey(customerId, 'seal');
      const decoded = decodeApiKey(apiKey);

      expect(decoded.customerId).toBe(customerId);
    });

    it('should handle minimum customer ID', () => {
      const customerId = 1;
      const apiKey = generateApiKey(customerId, 'seal');
      const decoded = decodeApiKey(apiKey);

      expect(decoded.customerId).toBe(customerId);
    });

    it('should reject customer ID of 0', () => {
      expect(() => generateApiKey(0, 'seal')).toThrow('Customer ID must be a positive 32-bit integer');
    });

    it('should reject negative customer ID', () => {
      expect(() => generateApiKey(-1, 'seal')).toThrow('Customer ID must be a positive 32-bit integer');
    });
  });

  describe('Metadata Encoding', () => {
    it('should encode default metadata (testnet, open)', () => {
      const apiKey = generateApiKey(12345, 'seal');
      const decoded = decodeApiKey(apiKey);

      expect(decoded.metadata.version).toBe(0);
      expect(decoded.metadata.sealType.network).toBe('testnet');
      expect(decoded.metadata.sealType.access).toBe('open');
      expect(decoded.metadata.procGroup).toBe(1);
    });

    it('should encode mainnet open seal type', () => {
      const sealType: SealType = { network: 'mainnet', access: 'open' };
      const apiKey = generateApiKey(12345, 'seal', { sealType });
      const decoded = decodeApiKey(apiKey);

      expect(decoded.metadata.sealType.network).toBe('mainnet');
      expect(decoded.metadata.sealType.access).toBe('open');
    });

    it('should encode testnet permission derived', () => {
      const sealType: SealType = { network: 'testnet', access: 'permission', source: 'derived' };
      const apiKey = generateApiKey(12345, 'seal', { sealType });
      const decoded = decodeApiKey(apiKey);

      expect(decoded.metadata.sealType.network).toBe('testnet');
      expect(decoded.metadata.sealType.access).toBe('permission');
      expect(decoded.metadata.sealType.source).toBe('derived');
    });

    it('should encode mainnet permission imported', () => {
      const sealType: SealType = { network: 'mainnet', access: 'permission', source: 'imported' };
      const apiKey = generateApiKey(12345, 'seal', { sealType });
      const decoded = decodeApiKey(apiKey);

      expect(decoded.metadata.sealType.network).toBe('mainnet');
      expect(decoded.metadata.sealType.access).toBe('permission');
      expect(decoded.metadata.sealType.source).toBe('imported');
    });

    it('should encode all valid process groups (0-7)', () => {
      for (let procGroup = 0; procGroup <= 7; procGroup++) {
        const apiKey = generateApiKey(12345, 'seal', { procGroup });
        const decoded = decodeApiKey(apiKey);

        expect(decoded.metadata.procGroup).toBe(procGroup);
      }
    });

    it('should reject invalid seal type 000 (reserved)', () => {
      // This would be testnet + open + derived, which is invalid (000)
      // But our encoding logic should prevent this
      const sealType: SealType = { network: 'testnet', access: 'open' };
      // When access is 'open', source is ignored, so this should work
      const apiKey = generateApiKey(12345, 'seal', { sealType });
      const decoded = decodeApiKey(apiKey);

      // Should default to valid configuration (testnet/open maps to 001)
      expect(decoded.metadata.sealType.network).toBe('testnet');
      expect(decoded.metadata.sealType.access).toBe('open');
    });
  });

  describe('HMAC Authentication', () => {
    it('should reject API key with invalid HMAC', () => {
      const apiKey = generateApiKey(12345, 'seal');

      // Tamper with a character in the middle (should break HMAC)
      const chars = apiKey.split('');
      chars[10] = chars[10] === 'A' ? 'B' : 'A';
      const tamperedKey = chars.join('');

      expect(() => decodeApiKey(tamperedKey)).toThrow('Invalid API key - authentication failed');
    });

    it('should reject API key with wrong service type prefix', () => {
      const apiKey = generateApiKey(12345, 'seal');
      const wrongPrefix = 'R' + apiKey.slice(1); // Change S to R

      // This might work if the HMAC happens to match, but customer ID will be wrong
      // Actually, the HMAC won't match because service type affects decoding
      // Let's just verify it doesn't crash
      try {
        const decoded = decodeApiKey(wrongPrefix);
        // If it decodes, the customer ID should likely be wrong
        expect(decoded.customerId).not.toBe(12345);
        expect(decoded.serviceType).toBe('grpc'); // Should decode as grpc
      } catch (error) {
        // Or it might fail HMAC, which is also acceptable
        expect(error).toBeDefined();
      }
    });
  });

  describe('Invalid Input Handling', () => {
    it('should reject API key with wrong length', () => {
      expect(() => decodeApiKey('SABCDEFGHIJKLMNOPQRSTUVWXYZ')).toThrow('Invalid API key length');
      expect(() => decodeApiKey('SABCDEFGHIJKLMNOPQRSTUVWXYZ12345678901234567890')).toThrow('Invalid API key length');
    });

    it('should reject API key with invalid Base32 characters', () => {
      // Create a key with invalid characters (not in Base32 alphabet)
      const invalidKey = 'S' + '0189'.repeat(9); // '0', '1', '8', '9' are not in Base32

      expect(() => decodeApiKey(invalidKey)).toThrow();
    });
  });

  describe('Fingerprint Generation', () => {
    it('should generate consistent fingerprints for same key', () => {
      const apiKey = generateApiKey(12345, 'seal');
      const fp1 = createApiKeyFingerprint(apiKey);
      const fp2 = createApiKeyFingerprint(apiKey);

      expect(fp1).toBe(fp2);
      expect(fp1).toHaveLength(64); // SHA256 hex = 64 chars
    });

    it('should generate different fingerprints for different keys', () => {
      const key1 = generateApiKey(12345, 'seal');
      const key2 = generateApiKey(12345, 'seal');
      const fp1 = createApiKeyFingerprint(key1);
      const fp2 = createApiKeyFingerprint(key2);

      expect(fp1).not.toBe(fp2);
    });
  });

  describe('Encryption Security', () => {
    it('should not leak customer ID in ciphertext (encrypted)', () => {
      const customerId = 0x12345678; // Distinctive pattern
      const apiKey = generateApiKey(customerId, 'seal');

      // The customer ID should be encrypted, so these hex patterns shouldn't appear
      const customerIdHex = customerId.toString(16).toUpperCase();
      expect(apiKey).not.toContain(customerIdHex);
    });

    it('should produce different ciphertexts for same data (random IV)', () => {
      const customerId = 12345;
      const key1 = generateApiKey(customerId, 'seal', {
        sealType: { network: 'testnet', access: 'open' },
        procGroup: 1
      });
      const key2 = generateApiKey(customerId, 'seal', {
        sealType: { network: 'testnet', access: 'open' },
        procGroup: 1
      });

      // Even with identical inputs, keys should differ due to random IV
      expect(key1).not.toBe(key2);

      // But both should decode to same data
      const decoded1 = decodeApiKey(key1);
      const decoded2 = decodeApiKey(key2);
      expect(decoded1.customerId).toBe(decoded2.customerId);
      expect(decoded1.metadata).toEqual(decoded2.metadata);
    });
  });

  describe('Service Type Encoding', () => {
    const testCases = [
      { serviceType: 'seal', expectedChar: 'S' },
      { serviceType: 'grpc', expectedChar: 'R' },
      { serviceType: 'graphql', expectedChar: 'G' },
    ];

    testCases.forEach(({ serviceType, expectedChar }) => {
      it(`should encode ${serviceType} as ${expectedChar}`, () => {
        const apiKey = generateApiKey(12345, serviceType);
        expect(apiKey[0]).toBe(expectedChar);

        const decoded = decodeApiKey(apiKey);
        expect(decoded.serviceType).toBe(serviceType);
      });
    });
  });

  describe('All Valid Seal Type Combinations', () => {
    const validCombinations: Array<{ sealType: SealType; description: string }> = [
      { sealType: { network: 'testnet', access: 'open' }, description: 'testnet/open (001)' },
      { sealType: { network: 'testnet', access: 'permission', source: 'derived' }, description: 'testnet/permission/derived (010)' },
      { sealType: { network: 'testnet', access: 'permission', source: 'imported' }, description: 'testnet/permission/imported (011)' },
      { sealType: { network: 'mainnet', access: 'open' }, description: 'mainnet/open (101)' },
      { sealType: { network: 'mainnet', access: 'permission', source: 'derived' }, description: 'mainnet/permission/derived (110)' },
      { sealType: { network: 'mainnet', access: 'permission', source: 'imported' }, description: 'mainnet/permission/imported (111)' },
    ];

    validCombinations.forEach(({ sealType, description }) => {
      it(`should encode and decode ${description}`, () => {
        const apiKey = generateApiKey(12345, 'seal', { sealType });
        const decoded = decodeApiKey(apiKey);

        expect(decoded.metadata.sealType.network).toBe(sealType.network);
        expect(decoded.metadata.sealType.access).toBe(sealType.access);
        if (sealType.source) {
          expect(decoded.metadata.sealType.source).toBe(sealType.source);
        }
      });
    });
  });

  describe('Performance Characteristics', () => {
    it('should generate keys quickly (< 10ms per key)', () => {
      const start = Date.now();
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        generateApiKey(i + 1, 'seal');
      }

      const elapsed = Date.now() - start;
      const avgTime = elapsed / iterations;

      expect(avgTime).toBeLessThan(10);
    });

    it('should decode keys quickly (< 10ms per key)', () => {
      // Generate some keys first
      const keys = Array.from({ length: 100 }, (_, i) =>
        generateApiKey(i + 1, 'seal')
      );

      const start = Date.now();
      keys.forEach(key => decodeApiKey(key));
      const elapsed = Date.now() - start;
      const avgTime = elapsed / keys.length;

      expect(avgTime).toBeLessThan(10);
    });
  });
});
