/**
 * Unit tests for Sui Transaction Service (Seal Key Registration)
 *
 * Tests the mock implementation used in development/testing for:
 * - KeyServer object registration on Sui blockchain
 * - Idempotency handling
 * - Deterministic object ID generation
 * - Failure injection for error handling tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SuiTransactionService,
  getSuiTransactionService,
  resetSuiTransactionService,
  setSuiTxMockConfig,
  clearSuiTxMockConfig,
  getSuiTxMockConfig,
  type RegisterKeyParams,
  type UpdateKeyParams,
} from '../src/lib/sui-transaction-service.js';

describe('Sui Transaction Service (Seal Key Registration)', () => {
  let service: SuiTransactionService;

  beforeEach(() => {
    // Reset service to clean state
    resetSuiTransactionService();
    service = getSuiTransactionService();
  });

  afterEach(() => {
    // Clean up
    resetSuiTransactionService();
  });

  describe('Service Initialization', () => {
    it('should identify as mock in test environment', () => {
      expect(service.isMock()).toBe(true);
    });

    it('should return singleton instance', () => {
      const service1 = getSuiTransactionService();
      const service2 = getSuiTransactionService();
      expect(service1).toBe(service2);
    });

    it('should reset to new instance after resetSuiTransactionService', () => {
      const service1 = getSuiTransactionService();
      resetSuiTransactionService();
      const service2 = getSuiTransactionService();
      expect(service1).not.toBe(service2);
    });
  });

  describe('Mock Configuration', () => {
    it('should set and get mock config', () => {
      setSuiTxMockConfig({ registerDelayMs: 1000 });
      const config = getSuiTxMockConfig();
      expect(config.registerDelayMs).toBe(1000);
    });

    it('should merge config on subsequent sets', () => {
      setSuiTxMockConfig({ registerDelayMs: 1000 });
      setSuiTxMockConfig({ updateDelayMs: 500 });
      const config = getSuiTxMockConfig();
      expect(config.registerDelayMs).toBe(1000);
      expect(config.updateDelayMs).toBe(500);
    });

    it('should clear config', () => {
      setSuiTxMockConfig({ registerDelayMs: 1000 });
      clearSuiTxMockConfig();
      const config = getSuiTxMockConfig();
      expect(config.registerDelayMs).toBeUndefined();
    });
  });

  describe('registerKey', () => {
    const createTestParams = (overrides?: Partial<RegisterKeyParams>): RegisterKeyParams => ({
      name: 'Test KeyServer',
      url: 'https://seal.example.com',
      keyType: 0, // BLS12-381 G1
      publicKey: Buffer.alloc(48, 0x42), // 48 bytes for G1
      network: 'testnet',
      ...overrides,
    });

    it('should register a new key and return object ID', async () => {
      // Use minimal delay for tests
      setSuiTxMockConfig({ registerDelayMs: 10 });

      const params = createTestParams();
      const result = await service.registerKey(params);

      expect(result.success).toBe(true);
      expect(result.objectId).toMatch(/^0x[a-f0-9]{64}$/);
      expect(result.txDigest).toMatch(/^0x[a-f0-9]{64}$/);
      expect(result.alreadyExists).toBe(false);
      expect(result.error).toBeUndefined();
    });

    it('should generate deterministic object IDs for same inputs', async () => {
      setSuiTxMockConfig({ registerDelayMs: 10 });

      const params = createTestParams();

      // First registration
      const result1 = await service.registerKey(params);
      expect(result1.success).toBe(true);

      // Reset service to clear mock registry
      resetSuiTransactionService();
      const freshService = getSuiTransactionService();
      setSuiTxMockConfig({ registerDelayMs: 10 });

      // Same params should produce same object ID
      const result2 = await freshService.registerKey(params);
      expect(result2.success).toBe(true);
      expect(result2.objectId).toBe(result1.objectId);
    });

    it('should generate different object IDs for different public keys', async () => {
      setSuiTxMockConfig({ registerDelayMs: 10 });

      const params1 = createTestParams({ publicKey: Buffer.alloc(48, 0x42) });
      const params2 = createTestParams({ publicKey: Buffer.alloc(48, 0x43) });

      const result1 = await service.registerKey(params1);
      const result2 = await service.registerKey(params2);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.objectId).not.toBe(result2.objectId);
    });

    it('should generate different object IDs for different networks', async () => {
      setSuiTxMockConfig({ registerDelayMs: 10 });

      const testnetParams = createTestParams({ network: 'testnet' });
      const mainnetParams = createTestParams({ network: 'mainnet' });

      const testnetResult = await service.registerKey(testnetParams);
      const mainnetResult = await service.registerKey(mainnetParams);

      expect(testnetResult.success).toBe(true);
      expect(mainnetResult.success).toBe(true);
      expect(testnetResult.objectId).not.toBe(mainnetResult.objectId);
    });

    describe('Idempotency', () => {
      it('should return same object on duplicate registration (by public key lookup)', async () => {
        setSuiTxMockConfig({ registerDelayMs: 10 });

        const params = createTestParams();

        // First registration
        const result1 = await service.registerKey(params);
        expect(result1.success).toBe(true);
        expect(result1.alreadyExists).toBe(false);

        // Second registration with same public key
        const result2 = await service.registerKey(params);
        expect(result2.success).toBe(true);
        expect(result2.alreadyExists).toBe(true);
        expect(result2.objectId).toBe(result1.objectId);
      });

      it('should return existing object when existingObjectId is provided', async () => {
        setSuiTxMockConfig({ registerDelayMs: 10 });

        const params = createTestParams();

        // First registration
        const result1 = await service.registerKey(params);
        expect(result1.success).toBe(true);

        // Use different public key but provide existing object ID
        const params2 = createTestParams({
          publicKey: Buffer.alloc(48, 0xFF),
          existingObjectId: result1.objectId,
        });

        const result2 = await service.registerKey(params2);
        expect(result2.success).toBe(true);
        expect(result2.alreadyExists).toBe(true);
        expect(result2.objectId).toBe(result1.objectId);
      });
    });

    describe('Failure Injection', () => {
      it('should fail with forced failure message', async () => {
        setSuiTxMockConfig({
          registerDelayMs: 10,
          forceRegisterFailure: 'Simulated blockchain error',
        });

        const params = createTestParams();
        const result = await service.registerKey(params);

        expect(result.success).toBe(false);
        expect(result.error).toBe('Simulated blockchain error');
        expect(result.objectId).toBeUndefined();
      });

      it('should handle probabilistic failures', async () => {
        // Set 100% failure rate
        setSuiTxMockConfig({
          registerDelayMs: 10,
          failureProbability: 1.0,
        });

        const params = createTestParams();
        const result = await service.registerKey(params);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Random mock failure');
      });
    });
  });

  describe('updateKey', () => {
    const createTestParams = (overrides?: Partial<RegisterKeyParams>): RegisterKeyParams => ({
      name: 'Test KeyServer',
      url: 'https://seal.example.com',
      keyType: 0,
      publicKey: Buffer.alloc(48, 0x42),
      network: 'testnet',
      ...overrides,
    });

    const createUpdateParams = (overrides?: Partial<UpdateKeyParams>): UpdateKeyParams => ({
      objectId: '0x' + 'a'.repeat(64),
      packages: ['0x' + 'b'.repeat(64), '0x' + 'c'.repeat(64)],
      network: 'testnet',
      ...overrides,
    });

    it('should update existing key with new packages', async () => {
      setSuiTxMockConfig({ registerDelayMs: 10, updateDelayMs: 10 });

      // First register a key
      const regParams = createTestParams();
      const regResult = await service.registerKey(regParams);
      expect(regResult.success).toBe(true);

      // Update the key
      const updateParams = createUpdateParams({
        objectId: regResult.objectId!,
        packages: ['0x' + 'd'.repeat(64)],
      });

      const updateResult = await service.updateKey(updateParams);
      expect(updateResult.success).toBe(true);
      expect(updateResult.objectId).toBe(regResult.objectId);
      expect(updateResult.txDigest).toMatch(/^0x[a-f0-9]{64}$/);
    });

    it('should fail to update non-existent key', async () => {
      setSuiTxMockConfig({ updateDelayMs: 10 });

      const updateParams = createUpdateParams({
        objectId: '0x' + 'f'.repeat(64), // Non-existent
      });

      const result = await service.updateKey(updateParams);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail with forced failure message', async () => {
      setSuiTxMockConfig({
        registerDelayMs: 10,
        updateDelayMs: 10,
        forceUpdateFailure: 'Update failed',
      });

      // Register a key first
      const regParams = createTestParams();
      const regResult = await service.registerKey(regParams);
      expect(regResult.success).toBe(true);

      // Try to update
      const updateParams = createUpdateParams({
        objectId: regResult.objectId!,
      });

      const updateResult = await service.updateKey(updateParams);
      expect(updateResult.success).toBe(false);
      expect(updateResult.error).toBe('Update failed');
    });
  });

  describe('findKeyServerByPublicKey', () => {
    it('should find registered key by public key', async () => {
      setSuiTxMockConfig({ registerDelayMs: 10 });

      const publicKey = Buffer.alloc(48, 0x42);
      const params: RegisterKeyParams = {
        name: 'Test',
        url: 'https://seal.example.com',
        keyType: 0,
        publicKey,
        network: 'testnet',
      };

      // Register
      const regResult = await service.registerKey(params);
      expect(regResult.success).toBe(true);

      // Find
      const found = await service.findKeyServerByPublicKey(publicKey, 'testnet');
      expect(found).not.toBeUndefined();
      expect(found!.objectId).toBe(regResult.objectId);
    });

    it('should not find key on wrong network', async () => {
      setSuiTxMockConfig({ registerDelayMs: 10 });

      const publicKey = Buffer.alloc(48, 0x42);
      const params: RegisterKeyParams = {
        name: 'Test',
        url: 'https://seal.example.com',
        keyType: 0,
        publicKey,
        network: 'testnet',
      };

      // Register on testnet
      await service.registerKey(params);

      // Search on mainnet
      const found = await service.findKeyServerByPublicKey(publicKey, 'mainnet');
      expect(found).toBeUndefined();
    });

    it('should return undefined for non-existent key', async () => {
      const publicKey = Buffer.alloc(48, 0xFF);
      const found = await service.findKeyServerByPublicKey(publicKey, 'testnet');
      expect(found).toBeUndefined();
    });
  });

  describe('checkObjectExists', () => {
    it('should return true for registered object', async () => {
      setSuiTxMockConfig({ registerDelayMs: 10 });

      const params: RegisterKeyParams = {
        name: 'Test',
        url: 'https://seal.example.com',
        keyType: 0,
        publicKey: Buffer.alloc(48, 0x42),
        network: 'testnet',
      };

      const regResult = await service.registerKey(params);
      expect(regResult.success).toBe(true);

      const exists = await service.checkObjectExists(regResult.objectId!, 'testnet');
      expect(exists).toBe(true);
    });

    it('should return false for non-existent object', async () => {
      const exists = await service.checkObjectExists('0x' + 'f'.repeat(64), 'testnet');
      expect(exists).toBe(false);
    });
  });
});