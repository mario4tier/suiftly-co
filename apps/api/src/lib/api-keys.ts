/**
 * API Key Management - Production Implementation
 * Implements API_KEY_DESIGN.md specification
 *
 * Format: <service><interleaved_payload_and_hmac>
 * - Service: Single char (S=Seal, R=gRPC, G=GraphQL)
 * - Interleaved: 36 chars (32-char Base32 + 4-char hex HMAC)
 * - Total: 37 characters
 *
 * Encryption: AES-128-CTR with random IV per key
 * Authentication: HMAC-SHA256 (2-byte tag, Encrypt-then-MAC)
 */

import { randomBytes, createCipheriv, createDecipheriv, createHmac, createHash } from 'crypto';
import { db } from '@suiftly/database';
import { apiKeys } from '@suiftly/database/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { encryptSecret, decryptSecret } from './encryption';
import { dbClock } from '@suiftly/shared/db-clock';

/**
 * API_SECRET_KEY - 32-byte key for AES-128-CTR encryption and HMAC-SHA256
 *
 * Test/Development (hardcoded):
 *   8776c4c0e84428c6e86fca4647abe16459649aa78fe4c72e7643dc3a14343337
 *   This is a well-known test key shared with walrus/system.conf
 *   Safe to hardcode as it's only used in test/dev environments
 *
 * Production:
 *   Loaded from KVCrypt (to be implemented)
 *   For now, can override with API_SECRET_KEY environment variable
 */
const TEST_SECRET_KEY = '8776c4c0e84428c6e86fca4647abe16459649aa78fe4c72e7643dc3a14343337';

const SECRET_KEY_HEX = process.env.API_SECRET_KEY || TEST_SECRET_KEY;
const SECRET_KEY = Buffer.from(SECRET_KEY_HEX, 'hex');

if (SECRET_KEY.length !== 32) {
  throw new Error('API_SECRET_KEY must be 32 bytes (64 hex characters)');
}

// ============================================================================
// Type Definitions
// ============================================================================

export interface SealType {
  network: 'mainnet' | 'testnet';       // bit 13: 1=mainnet, 0=testnet
  access: 'permission' | 'open';        // bit 12: 1=permission, 0=open
  source?: 'imported' | 'derived';      // bit 11: 1=imported, 0=derived (only when permission)
}

export interface KeyMetadata {
  version: number;         // 0-3 (2 bits) - currently 0
  sealType: SealType;      // 3 bits (abc) - seal key configuration
  procGroup: number;       // 0-7 (3 bits) - process group identifier (currently always 1)
}

export interface ApiKeyPayload {
  metadata: KeyMetadata;
  customerId: number;
}

export interface DecodedApiKey {
  customerId: number;
  serviceType: string;
  metadata: KeyMetadata;
}

// ============================================================================
// Base32 Encoding/Decoding (RFC 4648)
// ============================================================================

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function base32Decode(str: string): Buffer {
  str = str.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  let index = 0;
  const output = Buffer.alloc((str.length * 5) / 8);

  for (let i = 0; i < str.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(str[i]);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${str[i]}`);
    }

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      output[index++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }

  return output;
}

// ============================================================================
// HMAC Interleaving (Obfuscation)
// ============================================================================

/**
 * Interleave HMAC tag into Base32 payload (reversible swap for obfuscation)
 * Swap pattern (0-based): 2↔32, 8↔35, 23↔33, 15↔34
 */
function interleaveHmacTag(payload: string, tag: string): string {
  const combined = payload + tag; // 32 + 4 = 36 chars
  const chars = combined.split('');

  // Perform swaps
  [chars[2], chars[32]] = [chars[32], chars[2]];   // payload[2] ↔ tag[0]
  [chars[8], chars[35]] = [chars[35], chars[8]];   // payload[8] ↔ tag[3]
  [chars[23], chars[33]] = [chars[33], chars[23]]; // payload[23] ↔ tag[1]
  [chars[15], chars[34]] = [chars[34], chars[15]]; // payload[15] ↔ tag[2]

  return chars.join('');
}

/**
 * De-interleave to separate Base32 payload and HMAC tag
 * Same function works for both directions (reversible swap)
 */
function deinterleaveHmacTag(interleaved: string): { payload: string; tag: string } {
  const chars = interleaved.split('');

  // Reverse swaps (same pattern)
  [chars[2], chars[32]] = [chars[32], chars[2]];
  [chars[8], chars[35]] = [chars[35], chars[8]];
  [chars[23], chars[33]] = [chars[33], chars[23]];
  [chars[15], chars[34]] = [chars[34], chars[15]];

  const deinterleaved = chars.join('');
  return {
    payload: deinterleaved.slice(0, 32),
    tag: deinterleaved.slice(32, 36),
  };
}

// ============================================================================
// Metadata Encoding/Decoding
// ============================================================================

/**
 * Encode seal_type (3 bits)
 * a (bit 13): Network - 1=mainnet, 0=testnet
 * b (bit 12): Access - 1=permission, 0=open
 * c (bit 11): Source - 1=imported, 0=derived (only when permission)
 *
 * Note: For open access, bit c is always set to 1 to avoid reserved values (000, 100)
 */
function encodeSealType(sealType: SealType): number {
  const a = sealType.network === 'mainnet' ? 1 : 0;
  const b = sealType.access === 'permission' ? 1 : 0;

  let c: number;
  if (sealType.access === 'permission') {
    // For permission access, use the source field
    c = sealType.source === 'imported' ? 1 : 0;
  } else {
    // For open access, always set c=1 to avoid reserved combinations (000, 100)
    c = 1;
  }

  return (a << 2) | (b << 1) | c; // 3-bit value
}

/**
 * Encode metadata (2 bytes, big-endian)
 */
function encodeMetadata(meta: KeyMetadata): number {
  const sealTypeBits = encodeSealType(meta.sealType);

  return ((meta.version & 0b11) << 14) |      // bits 15-14: version
         ((sealTypeBits & 0b111) << 11) |     // bits 13-11: seal_type
         ((meta.procGroup & 0b111) << 8);     // bits 10-8: proc_group
                                              // bits 7-0: unused (zeros)
}

/**
 * Decode seal_type (3 bits)
 */
function decodeSealType(sealTypeBits: number): SealType {
  const a = (sealTypeBits >> 2) & 1; // bit 13 (network)
  const b = (sealTypeBits >> 1) & 1; // bit 12 (access)
  const c = sealTypeBits & 1;        // bit 11 (source)

  const network = a === 1 ? 'mainnet' : 'testnet';
  const access = b === 1 ? 'permission' : 'open';
  const source = (b === 1 && c === 1) ? 'imported' :
                 (b === 1 && c === 0) ? 'derived' :
                 undefined;

  return { network, access, source } as SealType;
}

/**
 * Decode metadata (2 bytes, big-endian)
 */
function decodeMetadata(value: number): KeyMetadata {
  const sealTypeBits = (value >> 11) & 0b111; // bits 13-11

  return {
    version: (value >> 14) & 0b11,           // bits 15-14
    sealType: decodeSealType(sealTypeBits),  // bits 13-11
    procGroup: (value >> 8) & 0b111,         // bits 10-8
  };
}

// ============================================================================
// Service Type Mapping
// ============================================================================

function serviceTypeToChar(serviceType: string): string {
  const map: Record<string, string> = { seal: 'S', grpc: 'R', graphql: 'G' };
  return map[serviceType] || 'S';
}

function charToServiceType(char: string): string {
  const map: Record<string, string> = { S: 'seal', R: 'grpc', G: 'graphql' };
  return map[char] || 'seal';
}

// ============================================================================
// API Key Generation
// ============================================================================

/**
 * Generate a production API key with encryption and authentication
 *
 * @param customerId Customer ID (32-bit integer)
 * @param serviceType Service type ('seal', 'grpc', 'graphql')
 * @param options Optional seal type and process group
 * @returns The generated API key (37 characters)
 */
export function generateApiKey(
  customerId: number,
  serviceType: string,
  options: {
    sealType?: SealType;
    procGroup?: number;
  } = {}
): string {
  // Validate customer ID
  if (customerId <= 0 || customerId > 0xFFFFFFFF) {
    throw new Error('Customer ID must be a positive 32-bit integer');
  }

  // 1. Generate random IV (4 bytes)
  const iv = randomBytes(4);

  // 2. Build 16-byte plaintext payload
  const plaintext = Buffer.alloc(16);

  const metadata = encodeMetadata({
    version: 0,
    sealType: options.sealType ?? { network: 'testnet', access: 'open' },
    procGroup: options.procGroup ?? 1,
  });

  plaintext.writeUInt16BE(metadata, 0);  // offset 0-1: metadata (2 bytes)
  // bytes 2-3: unused (zeros)
  plaintext.writeUInt32BE(customerId, 4); // offset 4-7: customer_id (4 bytes)
  // bytes 8-15: unused (zeros)

  // 3. Create full nonce for AES-128-CTR (16 bytes)
  const nonce = Buffer.concat([
    iv,                   // 4 bytes random IV
    Buffer.alloc(12, 0),  // 12 bytes padding (zeros)
  ]);

  // 4. Encrypt with AES-128-CTR
  const cipher = createCipheriv(
    'aes-128-ctr',
    SECRET_KEY.slice(0, 16), // First 16 bytes for AES-128
    nonce
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); // 16 bytes

  // 5. Combine IV + ciphertext for authentication
  const combined = Buffer.concat([iv, ciphertext]); // 20 bytes total

  // 6. Authenticate with HMAC-SHA256 (Encrypt-then-MAC)
  const hmac = createHmac('sha256', SECRET_KEY);
  hmac.update(combined);
  const tag = hmac.digest().slice(0, 2); // First 2 bytes

  // 7. Encode: Base32(IV + ciphertext) + Hex(tag)
  const base32Combined = base32Encode(combined);    // 32 chars
  const hexTag = tag.toString('hex').toUpperCase(); // 4 chars

  // 8. Interleave HMAC tag into payload (obfuscation)
  const interleaved = interleaveHmacTag(base32Combined, hexTag); // 36 chars

  // 9. Format: <service><interleaved>
  const serviceChar = serviceTypeToChar(serviceType);
  return `${serviceChar}${interleaved}`; // 37 chars total
}

// ============================================================================
// API Key Decoding
// ============================================================================

/**
 * Decode and verify an API key
 *
 * @param apiKey The API key to decode (37 characters)
 * @returns Decoded payload with customer ID, service type, and metadata
 * @throws Error if API key is invalid or authentication fails
 */
export function decodeApiKey(apiKey: string): DecodedApiKey {
  // 1. Validate length
  if (apiKey.length !== 37) {
    throw new Error('Invalid API key length');
  }

  // 2. Extract service type (first character)
  const serviceChar = apiKey[0];
  const serviceType = charToServiceType(serviceChar);

  // 3. Extract interleaved string (36 chars)
  const interleaved = apiKey.slice(1);

  // 4. De-interleave to separate payload and HMAC tag
  const { payload: base32Combined, tag: tagHex } = deinterleaveHmacTag(interleaved);

  // 5. Decode Base32 to get IV + ciphertext
  const combined = base32Decode(base32Combined); // 20 bytes (4 IV + 16 ciphertext)

  // 6. Verify HMAC-SHA256 authentication tag
  const hmac = createHmac('sha256', SECRET_KEY);
  hmac.update(combined);
  const expectedTag = hmac.digest().slice(0, 2);
  const expectedTagHex = expectedTag.toString('hex').toUpperCase();

  if (tagHex.toUpperCase() !== expectedTagHex) {
    throw new Error('Invalid API key - authentication failed');
  }

  // 7. Extract IV and ciphertext
  const iv = combined.slice(0, 4);      // First 4 bytes
  const ciphertext = combined.slice(4); // Remaining 16 bytes

  // 8. Create full nonce for AES-128-CTR
  const nonce = Buffer.concat([
    iv,                   // 4 bytes from API key
    Buffer.alloc(12, 0),  // 12 bytes padding (zeros)
  ]);

  // 9. Decrypt with AES-128-CTR
  const decipher = createDecipheriv(
    'aes-128-ctr',
    SECRET_KEY.slice(0, 16), // First 16 bytes for AES-128
    nonce
  );
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]); // 16 bytes

  // 10. Extract fields from plaintext
  const metadata = decodeMetadata(plaintext.readUInt16BE(0)); // offset 0-1 (2 bytes)
  const customerId = plaintext.readUInt32BE(4);               // offset 4-7 (4 bytes)

  // 11. Validate customer ID
  if (customerId === 0) {
    throw new Error('Invalid customer ID');
  }

  return {
    customerId,
    serviceType,
    metadata,
  };
}

// ============================================================================
// Database Operations
// ============================================================================

/**
 * Convert unsigned 32-bit integer to signed (for PostgreSQL storage)
 * Values >= 2^31 become negative via two's complement
 */
function toSigned32(unsigned: number): number {
  return unsigned > 0x7FFFFFFF ? unsigned - 0x100000000 : unsigned;
}

/**
 * Convert signed 32-bit integer to unsigned (for fingerprint calculation)
 * Negative values become values >= 2^31
 */
function toUnsigned32(signed: number): number {
  return signed < 0 ? signed + 0x100000000 : signed;
}

/**
 * Create API key fingerprint for database lookups
 * Extracts 7 Base32 characters from interleaved string (skipping hex HMAC positions)
 * Returns signed INTEGER for PostgreSQL storage
 */
export function createApiKeyFingerprint(apiKey: string): number {
  if (apiKey.length !== 37) {
    throw new Error('Invalid API key length');
  }

  // Interleaving swaps hex HMAC characters into Base32 payload:
  //   interleaved[2] ↔ tag[0] (hex) → apiKey[3]
  //   interleaved[8] ↔ tag[3] (hex) → apiKey[9]
  //   interleaved[15] ↔ tag[2] (hex) → apiKey[16]
  //   interleaved[23] ↔ tag[1] (hex) → apiKey[24]
  //
  // Extract 7 Base32 chars (skip service prefix at 0, skip hex positions):
  // Positions: 1, 2, 4, 5, 6, 7, 8 (all guaranteed Base32)
  const fingerprintChars =
    apiKey.slice(1, 3) +  // Positions 1-2
    apiKey.slice(4, 9);   // Positions 4-8 (skip 3 which is hex)

  // Decode Base32 to get 32-bit unsigned integer
  // 7 Base32 chars encode 35 bits, but we only use 32 bits
  const decoded = base32Decode(fingerprintChars);

  // Read as 32-bit unsigned big-endian integer
  const unsigned = decoded.readUInt32BE(0);

  // Convert to signed for PostgreSQL INTEGER storage
  return toSigned32(unsigned);
}

/**
 * Store a new API key in the database
 * Implements collision retry on api_key_fp (32-bit fingerprint can collide)
 */
export async function storeApiKey(options: {
  customerId: number;
  serviceType: string;
  sealType?: SealType;
  procGroup?: number;
  metadata?: Record<string, any>;
  tx?: any; // Optional transaction object
}) {
  const MAX_RETRIES = 10;
  const dbOrTx = options.tx || db;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Generate new API key on each attempt (not just new fingerprint)
    const plainKey = generateApiKey(
      options.customerId,
      options.serviceType,
      {
        sealType: options.sealType,
        procGroup: options.procGroup,
      }
    );

    const fingerprint = createApiKeyFingerprint(plainKey);
    const decoded = decodeApiKey(plainKey);

    try {
      // Encrypt API key before storing (AES-256-GCM with random IV)
      const encryptedKey = encryptSecret(plainKey);

      const [record] = await dbOrTx
        .insert(apiKeys)
        .values({
          apiKeyId: encryptedKey, // Store encrypted
          apiKeyFp: fingerprint,
          customerId: options.customerId,
          serviceType: options.serviceType,
          metadata: {
            ...options.metadata,
            version: decoded.metadata.version,
            sealType: decoded.metadata.sealType,
            procGroup: decoded.metadata.procGroup,
          },
          isUserEnabled: true,
          createdAt: dbClock.now(),
        })
        .returning();

      return {
        record,
        plainKey, // Return this to show user (only once!)
      };
    } catch (error: any) {
      // Check if it's a primary key collision on api_key_fp
      if (error.code === '23505' && error.constraint === 'api_keys_pkey') {
        // Collision on fingerprint - retry with new API key
        if (attempt === MAX_RETRIES - 1) {
          throw new Error('Failed to generate unique API key fingerprint after multiple attempts');
        }
        // Continue to next iteration
        continue;
      }

      // Different error - rethrow
      throw error;
    }
  }

  // Should never reach here due to throw in loop, but TypeScript needs this
  throw new Error('Failed to generate unique API key fingerprint');
}

/**
 * Verify an API key against the database
 */
export async function verifyApiKey(apiKey: string) {
  const fingerprint = createApiKeyFingerprint(apiKey);

  const record = await db.query.apiKeys.findFirst({
    where: and(
      eq(apiKeys.apiKeyFp, fingerprint),
      eq(apiKeys.isUserEnabled, true)
    ),
  });

  return record || null;
}

/**
 * Revoke an API key (soft delete)
 * @param apiKey - The plain (unencrypted) API key string
 * @param customerId - Customer ID for security verification
 */
export async function revokeApiKey(apiKey: string, customerId: number): Promise<boolean> {
  // Calculate fingerprint for lookup (api_key_id is encrypted, can't be used in WHERE)
  const fingerprint = createApiKeyFingerprint(apiKey);

  const result = await db
    .update(apiKeys)
    .set({
      isUserEnabled: false,
      revokedAt: dbClock.now(),
    })
    .where(
      and(
        eq(apiKeys.apiKeyFp, fingerprint),
        eq(apiKeys.customerId, customerId)
      )
    )
    .returning();

  return result.length > 0;
}

/**
 * Delete an API key (soft delete - marks as deleted but keeps in database)
 * This is irreversible from the UI but preserves data for debugging/audit
 * @param apiKey - The plain (unencrypted) API key string
 * @param customerId - Customer ID for security verification
 */
export async function deleteApiKey(apiKey: string, customerId: number): Promise<boolean> {
  // Calculate fingerprint for lookup (api_key_id is encrypted, can't be used in WHERE)
  const fingerprint = createApiKeyFingerprint(apiKey);

  const result = await db
    .update(apiKeys)
    .set({
      deletedAt: dbClock.now(),
    })
    .where(
      and(
        eq(apiKeys.apiKeyFp, fingerprint),
        eq(apiKeys.customerId, customerId)
      )
    )
    .returning();

  return result.length > 0;
}

/**
 * Re-enable a revoked API key
 * Can only re-enable keys that are revoked but not deleted
 * @param apiKey - The plain (unencrypted) API key string
 * @param customerId - Customer ID for security verification
 */
export async function reEnableApiKey(apiKey: string, customerId: number): Promise<boolean> {
  // Calculate fingerprint for lookup (api_key_id is encrypted, can't be used in WHERE)
  const fingerprint = createApiKeyFingerprint(apiKey);

  const result = await db
    .update(apiKeys)
    .set({
      isUserEnabled: true,
      revokedAt: null,
    })
    .where(
      and(
        eq(apiKeys.apiKeyFp, fingerprint),
        eq(apiKeys.customerId, customerId),
        eq(apiKeys.isUserEnabled, false) // Only re-enable if currently revoked
      )
    )
    .returning();

  return result.length > 0;
}

/**
 * Get all API keys for a customer and service
 * Always excludes deleted keys (deletedAt IS NOT NULL)
 */
export async function getApiKeys(
  customerId: number,
  serviceType: 'seal' | 'grpc' | 'graphql',
  includeInactive = false
) {
  const conditions = [
    eq(apiKeys.customerId, customerId),
    eq(apiKeys.serviceType, serviceType),
    isNull(apiKeys.deletedAt), // Exclude deleted keys
  ];

  if (!includeInactive) {
    conditions.push(eq(apiKeys.isUserEnabled, true));
  }

  return await db.query.apiKeys.findMany({
    where: and(...conditions),
    orderBy: (apiKeys, { desc }) => [desc(apiKeys.createdAt)],
  });
}
