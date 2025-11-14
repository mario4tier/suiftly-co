/**
 * Encryption utility for sensitive database fields
 * Based on APP_SECURITY_DESIGN.md specification
 *
 * Uses AES-256-GCM for authenticated encryption
 * - Confidentiality: AES-256 encryption
 * - Integrity: GCM authentication tag
 * - Freshness: Random IV per encryption
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Encrypt secret using AES-256-GCM with random IV.
 *
 * @param plaintext - The secret to encrypt (e.g., API key)
 * @returns Ciphertext in format: "IV:authTag:ciphertext" (all base64-encoded)
 *
 * @throws Error if DB_APP_FIELDS_ENCRYPTION_KEY not set or invalid length
 *
 * @example
 * const encrypted = encryptSecret('S4A2B3C4D5E6F7G8H9I0J1K2L3M4N5O6P7Q8R9');
 * // Returns: "rZ8j3kF9...==:hG4mP7...==:x9Q2..."
 */
export function encryptSecret(plaintext: string): string {
  // Load encryption key from environment
  const keyB64 = process.env.DB_APP_FIELDS_ENCRYPTION_KEY;
  if (!keyB64) {
    throw new Error(
      'DB_APP_FIELDS_ENCRYPTION_KEY not set!\n' +
      'See docs/APP_SECURITY_DESIGN.md for setup instructions.\n' +
      'Generate key: openssl rand -base64 32'
    );
  }

  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `DB_APP_FIELDS_ENCRYPTION_KEY must be 32 bytes (256 bits).\n` +
      `Current length: ${key.length} bytes\n` +
      `Generate new key: openssl rand -base64 32`
    );
  }

  // Generate random IV (initialization vector) for this secret
  // CRITICAL: IV must be unique per encryption to prevent pattern analysis
  const iv = randomBytes(16); // 128-bit IV for AES-GCM

  // Create cipher
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  // Encrypt plaintext
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  // Get authentication tag (verifies integrity on decryption)
  const authTag = cipher.getAuthTag().toString('base64');

  // Return all three components (needed for decryption)
  // Format: "IV:authTag:ciphertext"
  return `${iv.toString('base64')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt secret encrypted with encryptSecret().
 *
 * @param ciphertext - Encrypted secret in "IV:authTag:ciphertext" format
 * @returns The decrypted plaintext
 *
 * @throws Error if ciphertext format invalid or decryption fails
 *
 * @example
 * const plaintext = decryptSecret('rZ8j3kF9...==:hG4mP7...==:x9Q2...');
 * // Returns: "S4A2B3C4D5E6F7G8H9I0J1K2L3M4N5O6P7Q8R9"
 */
export function decryptSecret(ciphertext: string): string {
  // Load encryption key from environment
  const keyB64 = process.env.DB_APP_FIELDS_ENCRYPTION_KEY;
  if (!keyB64) {
    throw new Error(
      'DB_APP_FIELDS_ENCRYPTION_KEY not set!\n' +
      'Cannot decrypt without encryption key.'
    );
  }

  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `DB_APP_FIELDS_ENCRYPTION_KEY must be 32 bytes (256 bits).\n` +
      `Current length: ${key.length} bytes`
    );
  }

  // Parse ciphertext format: "IV:authTag:ciphertext"
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error(
      'Invalid ciphertext format. Expected "IV:authTag:ciphertext"'
    );
  }

  const [ivB64, authTagB64, encryptedB64] = parts;

  // Decode base64 components
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const encrypted = Buffer.from(encryptedB64, 'base64');

  // Validate IV length
  if (iv.length !== 16) {
    throw new Error(`Invalid IV length: ${iv.length} bytes (expected 16)`);
  }

  // Create decipher
  const decipher = createDecipheriv('aes-256-gcm', key, iv);

  // Set authentication tag (must be set before decryption)
  decipher.setAuthTag(authTag);

  // Decrypt ciphertext
  let decrypted = decipher.update(encrypted, undefined, 'utf8');

  try {
    decrypted += decipher.final('utf8');
  } catch (error) {
    throw new Error(
      'Decryption failed: Invalid authentication tag or corrupted data'
    );
  }

  return decrypted;
}
