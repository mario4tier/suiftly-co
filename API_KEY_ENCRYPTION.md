# API Key Encryption Implementation

This document explains the encryption implementation for API keys stored in the database.

## Overview

API keys are now **encrypted at rest** using AES-256-GCM authenticated encryption. This protects sensitive key material in case of database compromise.

## Architecture

### Storage Format

**Before encryption:**
- `api_key_id`: Plain 37-character API key (e.g., `S4A2B3C4D5E6...`)
- `api_key_fp`: SHA256 hash (64-char hex string)

**After encryption:**
- `api_key_id`: Encrypted ciphertext in format `IV:authTag:ciphertext` (all base64)
- `api_key_fp`: 32-bit INTEGER fingerprint (signed, used as PRIMARY KEY)

### Key Components

1. **Encryption Utility** ([apps/api/src/lib/encryption.ts](apps/api/src/lib/encryption.ts))
   - `encryptSecret(plaintext)` - Encrypts using AES-256-GCM
   - `decryptSecret(ciphertext)` - Decrypts and verifies integrity
   - Uses `DB_APP_FIELDS_ENCRYPTION_KEY` environment variable

2. **API Key Functions** ([apps/api/src/lib/api-keys.ts](apps/api/src/lib/api-keys.ts))
   - `storeApiKey()` - Encrypts before storing
   - `verifyApiKey()` - Looks up by fingerprint (no decryption needed)
   - `revokeApiKey()`, `deleteApiKey()`, `reEnableApiKey()` - Use fingerprint for lookup

3. **Database Schema**
   ```sql
   CREATE TABLE api_keys (
     api_key_fp INTEGER PRIMARY KEY,           -- 32-bit fingerprint for fast lookups
     api_key_id VARCHAR(100) UNIQUE NOT NULL,  -- Encrypted API key
     customer_id INTEGER NOT NULL,
     service_type VARCHAR(20) NOT NULL,
     -- ...
   );
   ```

## Encryption Details

### Algorithm: AES-256-GCM

- **Cipher**: AES-256 (256-bit key)
- **Mode**: GCM (Galois/Counter Mode)
- **Benefits**:
  - **Confidentiality**: AES-256 encryption
  - **Integrity**: GCM authentication tag detects tampering
  - **Freshness**: Random IV per encryption prevents pattern analysis

### Encryption Process

```typescript
// 1. Generate random IV (16 bytes)
const iv = randomBytes(16);

// 2. Encrypt plaintext with AES-256-GCM
const cipher = createCipheriv('aes-256-gcm', key, iv);
const ciphertext = cipher.update(plaintext) + cipher.final();

// 3. Get authentication tag (16 bytes)
const authTag = cipher.getAuthTag();

// 4. Return: "IV:authTag:ciphertext" (all base64-encoded)
return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
```

### Decryption Process

```typescript
// 1. Parse format: "IV:authTag:ciphertext"
const [ivB64, authTagB64, ciphertextB64] = encrypted.split(':');

// 2. Decode base64 components
const iv = Buffer.from(ivB64, 'base64');
const authTag = Buffer.from(authTagB64, 'base64');
const ciphertext = Buffer.from(ciphertextB64, 'base64');

// 3. Decrypt with AES-256-GCM
const decipher = createDecipheriv('aes-256-gcm', key, iv);
decipher.setAuthTag(authTag);  // Verifies integrity
const plaintext = decipher.update(ciphertext) + decipher.final();

return plaintext;
```

## Setup

### 1. Generate Encryption Key

```bash
# Generate 256-bit (32-byte) key
openssl rand -base64 32
```

### 2. Set Environment Variable

**Development (`~/.suiftly.env`):**
```bash
# ~/.suiftly.env
DB_APP_FIELDS_ENCRYPTION_KEY="<base64-encoded-key>"
```

**Production (`~/.suiftly.env`):**
```bash
# ~/.suiftly.env
# Back up this key securely (password manager) before production use
DB_APP_FIELDS_ENCRYPTION_KEY="<base64-encoded-key>"
```

**IMPORTANT**:
- **Never commit the encryption key to git**
- Use different keys for dev/staging/production
- Back up the key securely - lost keys = unrecoverable data

## API Key Lifecycle

### 1. Creation (User Creates API Key)

```typescript
// Generate API key (37 chars)
const plainKey = generateApiKey(customerId, 'seal');
// → "S4A2B3C4D5E6F7G8H9I0J1K2L3M4N5O6P7Q8R9"

// Calculate fingerprint (32-bit integer)
const fingerprint = createApiKeyFingerprint(plainKey);
// → 1234567890 (can be positive or negative)

// Encrypt API key
const encryptedKey = encryptSecret(plainKey);
// → "rZ8j3kF9...==:hG4mP7...==:x9Q2..."

// Store in database
await db.insert(apiKeys).values({
  apiKeyFp: fingerprint,      // PRIMARY KEY (for fast lookups)
  apiKeyId: encryptedKey,     // UNIQUE (encrypted storage)
  customerId,
  serviceType: 'seal',
  // ...
});

// Return plain key to user (ONLY ONCE!)
return { plainKey };
```

### 2. Verification (HAProxy Authenticates Request)

```typescript
// Client sends API key in request
const apiKey = request.headers['x-api-key'];

// Calculate fingerprint
const fingerprint = createApiKeyFingerprint(apiKey);

// Lookup by fingerprint (fast INTEGER primary key)
const record = await db.query.apiKeys.findFirst({
  where: and(
    eq(apiKeys.apiKeyFp, fingerprint),
    eq(apiKeys.isActive, true)
  )
});

// If found and active, request is authenticated
// No decryption needed for authentication!
```

### 3. Revocation (User Revokes Key)

```typescript
// User provides full API key to revoke
const apiKey = input.apiKeyId;  // 37-char plain key

// Calculate fingerprint
const fingerprint = createApiKeyFingerprint(apiKey);

// Revoke by fingerprint (not by encrypted api_key_id)
await db.update(apiKeys)
  .set({ isActive: false, revokedAt: new Date() })
  .where(and(
    eq(apiKeys.apiKeyFp, fingerprint),
    eq(apiKeys.customerId, customerId)
  ));
```

## Security Properties

### ✅ Confidentiality

- API keys encrypted with AES-256 (industry standard)
- Keys protected even if database is compromised
- Different ciphertext each time (random IV)

### ✅ Integrity

- GCM authentication tag detects any tampering
- Decryption fails if ciphertext is modified
- Protects against bit-flip attacks

### ✅ Performance

- **Lookups use fingerprint**: No decryption needed for authentication
- **Fast PRIMARY KEY**: INTEGER (4 bytes) vs UUID (16 bytes) or VARCHAR
- **Encryption overhead**: ~1-2ms per operation (acceptable for creation/revocation)

### ✅ Non-Deterministic Encryption

- Random IV per encryption
- Same plain key → different ciphertext each time
- Prevents pattern analysis
- **IMPORTANT**: Cannot query by `api_key_id` in WHERE clauses (use `api_key_fp` instead)

## Testing

### Run All Tests

```bash
# Unit tests (encryption utility)
cd apps/api && npm test -- encryption.test.ts

# Unit tests (API key generation + fingerprint)
npm test -- api-keys.test.ts

# Integration tests (database encryption)
npm test -- api-keys-db.test.ts
```

### What Tests Verify

**Encryption Tests:**
- ✅ Round-trip encryption/decryption
- ✅ Non-deterministic encryption (random IV)
- ✅ Authentication tag verification
- ✅ Error handling (corrupted data, wrong key)
- ✅ Performance (< 5ms per operation)

**Integration Tests:**
- ✅ API keys stored encrypted (not plain text)
- ✅ Encrypted format: `IV:authTag:ciphertext`
- ✅ Decrypted values match original plain keys
- ✅ Fingerprints calculated from decrypted keys match stored fingerprints
- ✅ All encrypted values are unique (different IVs)

## Migration Guide

### Existing Databases (Plain Text → Encrypted)

If you have existing API keys stored in plain text:

```sql
-- WARNING: This is destructive! Backup first!
-- Cannot migrate in-place because encryption is non-deterministic
-- Options:

-- Option 1: Regenerate all API keys (recommended)
-- Users must create new API keys after migration

-- Option 2: Encrypt in application code
-- Read plain keys, encrypt, update (complex, requires downtime)
```

### Fresh Databases

No migration needed - just set `DB_APP_FIELDS_ENCRYPTION_KEY` and start the API server.

## Troubleshooting

### Error: "DB_APP_FIELDS_ENCRYPTION_KEY not set"

**Solution**: Add encryption key to `~/.suiftly.env` file:
```bash
openssl rand -base64 32
# Copy output to ~/.suiftly.env
```

### Error: "must be 32 bytes"

**Solution**: The base64 string must decode to exactly 32 bytes:
```bash
# Verify key length
echo "YOUR_KEY_HERE" | base64 -d | wc -c
# Should output: 32
```

### Error: "Decryption failed: Invalid authentication tag"

**Causes**:
- Wrong encryption key
- Corrupted data in database
- Data tampered with

**Solution**: Verify `DB_APP_FIELDS_ENCRYPTION_KEY` matches the key used for encryption.

### Error: "Invalid ciphertext format"

**Cause**: Data in database is not in `IV:authTag:ciphertext` format

**Solution**: Check if data is actually encrypted. May need to re-encrypt or regenerate.

## Performance Considerations

### Encryption Overhead

- **Encryption**: ~1-2ms per key (one-time at creation)
- **Decryption**: ~1-2ms per key (rare - only for admin operations)
- **Authentication**: 0ms (uses fingerprint, no decryption)

### Database Impact

- **Storage**: Ciphertext is ~70% larger than plaintext
  - Plain key: 37 chars
  - Encrypted: ~100 chars (IV:authTag:ciphertext in base64)
- **Queries**: No impact (lookups use `api_key_fp` PRIMARY KEY)

## Best Practices

1. **Key Rotation**: Plan to rotate `DB_APP_FIELDS_ENCRYPTION_KEY` periodically
2. **Key Storage**: Use secrets manager in production (AWS Secrets Manager, Vault)
3. **Backups**: Back up encryption key separately from database
4. **Logging**: Never log plain API keys or encryption keys
5. **Access Control**: Limit who can access `DB_APP_FIELDS_ENCRYPTION_KEY`

## References

- [APP_SECURITY_DESIGN.md](docs/APP_SECURITY_DESIGN.md) - Security design specification
- [CUSTOMER_SERVICE_SCHEMA.md](docs/CUSTOMER_SERVICE_SCHEMA.md) - Database schema
- [API_KEY_DESIGN.md](docs/API_KEY_DESIGN.md) - API key format specification
