/**
 * Unit tests for encryption utility
 * Tests AES-256-GCM encryption/decryption
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';

// Set up test encryption key before importing encryption module
process.env.DB_APP_FIELDS_ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { encryptSecret, decryptSecret } from '../src/lib/encryption';

describe('Encryption Utility', () => {
  describe('Basic Encryption/Decryption', () => {
    it('should encrypt and decrypt a simple string', () => {
      const plaintext = 'hello world';
      const encrypted = encryptSecret(plaintext);
      const decrypted = decryptSecret(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt an API key', () => {
      const apiKey = 'S4A2B3C4D5E6F7G8H9I0J1K2L3M4N5O6P7Q8R9';
      const encrypted = encryptSecret(apiKey);
      const decrypted = decryptSecret(encrypted);

      expect(decrypted).toBe(apiKey);
    });

    it('should handle special characters', () => {
      const plaintext = 'Test!@#$%^&*()_+-={}[]|\\:";\'<>?,./';
      const encrypted = encryptSecret(plaintext);
      const decrypted = decryptSecret(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle Unicode characters', () => {
      const plaintext = 'Hello 世界 🌍';
      const encrypted = encryptSecret(plaintext);
      const decrypted = decryptSecret(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle empty string', () => {
      const plaintext = '';
      const encrypted = encryptSecret(plaintext);
      const decrypted = decryptSecret(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle very long strings', () => {
      const plaintext = 'a'.repeat(10000);
      const encrypted = encryptSecret(plaintext);
      const decrypted = decryptSecret(encrypted);

      expect(decrypted).toBe(plaintext);
    });
  });

  describe('Encryption Format', () => {
    it('should return encrypted data in IV:authTag:ciphertext format', () => {
      const plaintext = 'test';
      const encrypted = encryptSecret(plaintext);

      // Should have 3 parts separated by colons
      const parts = encrypted.split(':');
      expect(parts).toHaveLength(3);

      // All parts should be base64 (alphanumeric + / + = + valid base64 chars)
      parts.forEach(part => {
        expect(part).toMatch(/^[A-Za-z0-9+/=]+$/);
      });
    });

    it('should have 16-byte IV (22-24 base64 chars)', () => {
      const encrypted = encryptSecret('test');
      const [ivB64] = encrypted.split(':');

      // 16 bytes = 22-24 base64 chars (with padding)
      const iv = Buffer.from(ivB64, 'base64');
      expect(iv.length).toBe(16);
    });

    it('should have authentication tag', () => {
      const encrypted = encryptSecret('test');
      const [, authTagB64] = encrypted.split(':');

      // GCM auth tag is 16 bytes = 22-24 base64 chars
      const authTag = Buffer.from(authTagB64, 'base64');
      expect(authTag.length).toBe(16);
    });
  });

  describe('Non-Deterministic Encryption', () => {
    it('should produce different ciphertexts for same plaintext (random IV)', () => {
      const plaintext = 'test';

      const encrypted1 = encryptSecret(plaintext);
      const encrypted2 = encryptSecret(plaintext);
      const encrypted3 = encryptSecret(plaintext);

      // Ciphertexts should all be different (due to random IV)
      expect(encrypted1).not.toBe(encrypted2);
      expect(encrypted2).not.toBe(encrypted3);
      expect(encrypted1).not.toBe(encrypted3);

      // But all should decrypt to same plaintext
      expect(decryptSecret(encrypted1)).toBe(plaintext);
      expect(decryptSecret(encrypted2)).toBe(plaintext);
      expect(decryptSecret(encrypted3)).toBe(plaintext);
    });

    it('should have different IVs for each encryption', () => {
      const plaintext = 'test';

      const encrypted1 = encryptSecret(plaintext);
      const encrypted2 = encryptSecret(plaintext);

      const [iv1] = encrypted1.split(':');
      const [iv2] = encrypted2.split(':');

      expect(iv1).not.toBe(iv2);
    });
  });

  describe('Error Handling', () => {
    it('should throw on invalid ciphertext format', () => {
      expect(() => decryptSecret('invalid')).toThrow('Invalid ciphertext format');
      expect(() => decryptSecret('only:two')).toThrow('Invalid ciphertext format');
      expect(() => decryptSecret('too:many:parts:here')).toThrow('Invalid ciphertext format');
    });

    it('should throw on corrupted ciphertext', () => {
      const encrypted = encryptSecret('test');
      const [iv, authTag, ciphertext] = encrypted.split(':');

      // Corrupt the ciphertext by flipping the first character
      const chars = ciphertext.split('');
      chars[0] = chars[0] === 'A' ? 'Z' : 'A';
      const corruptedCiphertext = chars.join('');
      const corrupted = `${iv}:${authTag}:${corruptedCiphertext}`;

      expect(() => decryptSecret(corrupted)).toThrow();
    });

    it('should throw on corrupted authentication tag', () => {
      const encrypted = encryptSecret('test');
      const [iv, authTag, ciphertext] = encrypted.split(':');

      // Corrupt the auth tag by flipping the first character
      const chars = authTag.split('');
      chars[0] = chars[0] === 'A' ? 'Z' : 'A';
      const corruptedTag = chars.join('');
      const corrupted = `${iv}:${corruptedTag}:${ciphertext}`;

      expect(() => decryptSecret(corrupted)).toThrow();
    });

    it('should throw on tampered IV', () => {
      const encrypted = encryptSecret('test');
      const [iv, authTag, ciphertext] = encrypted.split(':');

      // Use different IV
      const tamperedIv = Buffer.from(randomBytes(16)).toString('base64');
      const tampered = `${tamperedIv}:${authTag}:${ciphertext}`;

      expect(() => decryptSecret(tampered)).toThrow('Decryption failed');
    });

    it('should throw if encryption key not set', () => {
      const originalKey = process.env.DB_APP_FIELDS_ENCRYPTION_KEY;
      delete process.env.DB_APP_FIELDS_ENCRYPTION_KEY;

      expect(() => encryptSecret('test')).toThrow('DB_APP_FIELDS_ENCRYPTION_KEY not set');

      process.env.DB_APP_FIELDS_ENCRYPTION_KEY = originalKey;
    });

    it('should throw if encryption key is wrong length', () => {
      const originalKey = process.env.DB_APP_FIELDS_ENCRYPTION_KEY;
      process.env.DB_APP_FIELDS_ENCRYPTION_KEY = Buffer.from('tooshort').toString('base64');

      expect(() => encryptSecret('test')).toThrow('must be 32 bytes');

      process.env.DB_APP_FIELDS_ENCRYPTION_KEY = originalKey;
    });
  });

  describe('Security Properties', () => {
    it('should not leak plaintext in ciphertext', () => {
      const plaintext = 'VERYDISTINCTIVEPATTERN12345';
      const encrypted = encryptSecret(plaintext);

      // Ciphertext should not contain the plaintext
      expect(encrypted).not.toContain(plaintext);
      expect(encrypted.toLowerCase()).not.toContain(plaintext.toLowerCase());
    });

    it('should produce ciphertext longer than plaintext (includes IV + tag)', () => {
      const plaintext = 'short';
      const encrypted = encryptSecret(plaintext);

      // Encrypted format: IV(16 bytes) + authTag(16 bytes) + ciphertext (>= plaintext length)
      // Base64 encoded: ~64+ characters
      expect(encrypted.length).toBeGreaterThan(plaintext.length);
      expect(encrypted.length).toBeGreaterThan(50); // At least 50 chars for overhead
    });

    it('should support round-trip for many different plaintexts', () => {
      const testCases = [
        'a',
        'ab',
        'abc',
        '1234567890',
        'Special!@#$%^&*()Chars',
        '你好世界',
        '🎉🎊🎈',
        'A'.repeat(100),
        JSON.stringify({ test: 'data', nested: { value: 123 } }),
      ];

      testCases.forEach(plaintext => {
        const encrypted = encryptSecret(plaintext);
        const decrypted = decryptSecret(encrypted);
        expect(decrypted).toBe(plaintext);
      });
    });
  });

  describe('Performance', () => {
    it('should encrypt quickly (< 5ms per operation)', () => {
      const plaintext = 'test string for encryption';
      const iterations = 100;

      const start = Date.now();
      for (let i = 0; i < iterations; i++) {
        encryptSecret(plaintext);
      }
      const elapsed = Date.now() - start;

      const avgTime = elapsed / iterations;
      expect(avgTime).toBeLessThan(5);
    });

    it('should decrypt quickly (< 5ms per operation)', () => {
      const plaintext = 'test string for decryption';
      const encrypted = encryptSecret(plaintext);
      const iterations = 100;

      const start = Date.now();
      for (let i = 0; i < iterations; i++) {
        decryptSecret(encrypted);
      }
      const elapsed = Date.now() - start;

      const avgTime = elapsed / iterations;
      expect(avgTime).toBeLessThan(5);
    });
  });
});
