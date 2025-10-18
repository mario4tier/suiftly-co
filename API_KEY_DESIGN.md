# API Key Design

## Overview

This document defines the API key architecture for authenticating service requests in the Suiftly platform. API keys map to customer accounts for billing and rate limiting while providing fast decode performance for HAProxy integration.

## Requirements

1. **Customer Identification**: API key must quickly resolve to a customer account
2. **Seal Key Association**: Each API key is tied to a specific Seal Key (for Seal service)
3. **Multiple Keys per Seal Key**: A customer can have multiple API keys for the same Seal Key
4. **Interchangeable within Seal Key**: All API keys for the same Seal Key are functionally equivalent
5. **Revocable**: Keys can be revoked/rotated without affecting other keys
6. **Secure**: Knowledge of one API key must not enable derivation of other keys
7. **High Performance**: Lookup must be extremely fast (HAProxy-compatible)

**Note**: For the Seal service, API keys authenticate requests and identify which Seal Key to use for signing operations. A customer with multiple Seal Keys will have separate API keys for each Seal Key.

## API Key Structure

### Format

```
API Key Structure:
  <service><base32_payload><checksum>

Example:
  SABCDEFGHIJKLMNOPQRST1A2B
  │└──────────┬───────┘└┬─┘
  │           │         │
  1 char    20 chars   4 chars
  Service   Payload    Checksum

Components:
  - Service: Single uppercase character (S=Seal, R=gRPC, G=GraphQL)
  - Payload: Base32-encoded data (12 bytes → 20 chars, fixed length)
  - Checksum: HMAC-SHA256 signature (2 bytes → 4 chars hex, uppercase)

Service Type Identifiers:
  - S → Seal service
  - R → gRPC service (future)
  - G → GraphQL service (future)

Total Length: 25 characters (fixed)
```

### Payload Structure

**Note:** This payload structure is defined for the **Seal service**. Future services (gRPC, GraphQL) may use different payload structures while maintaining the same overall API key format (service prefix + 20-char payload + 4-char hex checksum).

```
Seal Service Payload Structure (12 bytes):
  ┌──────────────┬────────────┬─────────────┬──────────┐
  │ key_metadata │ derivation │ customer_id │ reserved │
  │ 1 byte       │ 3 bytes    │ 4 bytes     │ 4 bytes  │
  └──────────────┴────────────┴─────────────┴──────────┘

Key Metadata Byte (8 bits) - FIRST BYTE:
  ┌────────┬──────────┬─────────────────────┐
  │ version│ imported │ master_key_group    │
  │ 2 bits │ 1 bit    │ 5 bits              │
  └────────┴──────────┴─────────────────────┘

  - Version: 00 (current), supports up to 4 versions
  - Imported: 0=derived key, 1=imported from external system
  - Master Key Group: 1 (default), supports up to 32 groups

Derivation (3 bytes):
  - 24-bit index (16M+ keys per master_key_group)
  - Scope: per master_key_group (NOT per customer)
  - Only used if imported=0 (derived key)
  - Set to 0 if imported=1

Customer ID (4 bytes):
  - 32-bit random integer (1 to 4,294,967,295)
  - Cryptographically random (prevents enumeration attacks)
  - Value 0 is reserved/invalid
  - Collision probability negligible (< 0.023% with 1M customers)

Reserved (4 bytes):
  - Currently set to zero
  - Available for future protocol extensions
  - Maintains consistent key length
  - Could be used for: timestamps, additional metadata, or sharding hints
```

## Implementation

### Key Generation

```typescript
interface KeyMetadata {
  version: number;        // 0-3 (2 bits) - currently 0
  isImported: boolean;    // 1 bit - false for derived, true for imported
  masterKeyGroup: number; // 0-31 (5 bits) - currently 1
}

interface ApiKeyPayload {
  metadata: KeyMetadata;  // 1 byte (offset 0)
  derivation: number;     // 3 bytes (offset 1-3, 0 if imported)
  customerId: number;     // 4 bytes (offset 4-7)
  reserved: Buffer;       // 4 bytes (offset 8-11, zeros)
}

// Encode metadata byte
function encodeMetadata(meta: KeyMetadata): number {
  return (
    (meta.version & 0b11) << 6 |           // bits 7-6: version
    (meta.isImported ? 1 : 0) << 5 |       // bit 5: imported flag
    (meta.masterKeyGroup & 0b11111)        // bits 4-0: master key group
  );
}

// Generate API key
function generateApiKey(
  customerId: number,
  serviceType: string,
  options: {
    isImported?: boolean;
    derivation?: number;
    masterKeyGroup?: number;
  } = {}
): string {
  const payload = Buffer.alloc(12);

  // 1. Key metadata (1 byte) - FIRST BYTE (offset 0)
  const metadata = encodeMetadata({
    version: 0,
    isImported: options.isImported ?? false,
    masterKeyGroup: options.masterKeyGroup ?? 1,
  });
  payload[0] = metadata;

  // 2. Derivation (3 bytes) - offset 1-3
  if (!options.isImported && options.derivation !== undefined) {
    payload.writeUIntBE(options.derivation, 1, 3);
  }
  // bytes 1-3: derivation or zeros

  // 3. Customer ID (4 bytes) - offset 4-7
  payload.writeUInt32BE(customerId, 4);

  // 4. Reserved (4 bytes) - offset 8-11, always zero for now
  // bytes 8-11: zeros (already initialized)

  // 5. Encode to Base32 (always 20 characters for 12 bytes)
  const base32Payload = base32Encode(payload);

  // 6. Generate HMAC-SHA256 checksum (prevents key forgery)
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(payload);
  const signature = hmac.digest().slice(0, 2); // First 2 bytes
  const checksum = signature.toString('hex').toUpperCase(); // 4 hex chars (uppercase)

  // 7. Format: <service><payload><checksum>
  const serviceChar = serviceTypeToChar(serviceType); // S, R, or G
  return `${serviceChar}${base32Payload}${checksum}`;
}

// Service type mapping
function serviceTypeToChar(serviceType: string): string {
  const map = { seal: 'S', grpc: 'R', graphql: 'G' };
  return map[serviceType] || 'S';
}

function charToServiceType(char: string): string {
  const map = { S: 'seal', R: 'grpc', G: 'graphql' };
  return map[char] || 'seal';
}
```

### Key Decoding

```typescript
// Decode API key
function decodeApiKey(apiKey: string): {
  customerId: number;
  serviceType: string;
  metadata: KeyMetadata;
  derivation?: number;
} {
  // Extract service char (first character)
  const serviceChar = apiKey[0];
  const serviceType = charToServiceType(serviceChar);

  // Extract payload and checksum
  const base32Payload = apiKey.slice(1, 21);  // Characters 1-20 (20 chars)
  const checksumHex = apiKey.slice(21);       // Last 4 chars (hex)

  // Decode Base32 payload
  const payload = base32Decode(base32Payload);

  // Verify HMAC-SHA256 checksum
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(payload);
  const expectedSignature = hmac.digest().slice(0, 2);
  const expectedChecksum = expectedSignature.toString('hex').toUpperCase();

  if (checksumHex.toUpperCase() !== expectedChecksum) {
    throw new Error('Invalid API key - authentication failed');
  }

  // 1. Extract metadata (offset 0, 1 byte)
  const metadata = decodeMetadata(payload[0]);

  // 2. Extract derivation if derived key (offset 1-3, 3 bytes)
  let derivation: number | undefined;
  if (!metadata.isImported) {
    derivation = payload.readUIntBE(1, 3);
  }

  // 3. Extract customer ID (offset 4-7, 4 bytes)
  const customerId = payload.readUInt32BE(4);

  // 4. Reserved bytes ignored (offset 8-11, future use)

  return {
    customerId,
    serviceType,
    metadata,
    derivation,
  };
}
```

## Encoding Rationale

### Hybrid Encoding Approach

**Payload (20 chars):** Base32 encoding
- **Fast decode performance**: ~10-20ns vs Base58's ~200ns
- **Fixed length encoding**: Always 20 chars for 12 bytes
- **No ambiguous characters**: Uses A-Z, 2-7 only
- **Case-insensitive**: Easier to read/type
- **Standard encoding**: RFC 4648 with excellent library support

**Checksum (4 chars):** Hex encoding (uppercase)
- **Exact fit**: 2 bytes = exactly 4 hex characters (no padding waste)
- **Fast validation**: Immediate failure detection with simple string comparison
- **Efficient**: No padding overhead unlike Base32 (which would need 4 chars for 2 bytes)
- **Clear separation**: Hex chars (0-9, A-F) are distinct from Base32 alphabet (A-Z, 2-7)

### Encoding Comparison

| Component | Encoding | Size | Bits/char | Efficiency |
|-----------|----------|------|-----------|------------|
| Service | Single char | 1 byte | N/A | Perfect |
| **Payload** | **Base32** | **12 bytes → 20 chars** | **5** | ✓ **Optimal** |
| **Checksum** | **Hex** | **2 bytes → 4 chars** | **4** | ✓ **Perfect fit** |

### Format Benefits

- **10x faster decode** than Base58 (~20ns vs ~200ns)
- **Fixed length**: Always exactly 25 characters (no variation)
- **Efficient checksum**: Hex encoding avoids Base32 padding waste
- **Fast failure**: Invalid checksums detected immediately
- Single character service identifier
- All uppercase (consistent, professional appearance)

## Customer Mapping

### Customer ID Generation

Customer IDs are randomly generated to prevent enumeration attacks:

```typescript
// Generate random customer ID (excludes 0)
async function generateCustomerId(): Promise<number> {
  let customerId: number;
  let inserted = false;

  while (!inserted) {
    // Generate random 32-bit integer (1 to 4,294,967,295)
    customerId = crypto.randomInt(1, 0x100000000); // 2^32

    try {
      // Attempt to insert (will fail if collision)
      await db.insert('customers', {
        customer_id: customerId,
        // ... other fields
      });
      inserted = true;
    } catch (err) {
      if (err.code === 'UNIQUE_VIOLATION') {
        // Collision detected (extremely rare), retry
        continue;
      }
      throw err;
    }
  }

  return customerId;
}
```

### Why Random IDs?

- **Security**: Prevents attacker from enumerating all customer IDs
- **Privacy**: Hides customer count and growth rate
- **Attack prevention**: Even with decoded API keys, can't guess other customer IDs
- **Same size**: Still 4 bytes (no payload increase)

### Collision Probability

- With 1M customers: ~0.023% chance of collision
- With 10M customers: ~2.3% chance of collision
- Retry loop handles collisions automatically
- Expected retries: < 1 per 1000 customer creations

## HAProxy Integration

### Fast Lookup Mechanism

**Challenge**: HAProxy sticky tables need a consistent key across all API keys for a customer.

**Solution**: Decode customer_id directly from the API key (no database lookup needed)

```
Sticky Table Key = customer_id (or customer_id + service_byte for multi-service)

Properties:
  - Same for all API keys belonging to one customer+service
  - Extracted directly from API key payload (no DB query)
  - Extremely fast (~20ns for Base32 decode)
  - Stable (doesn't change when keys are rotated)
  - Compact (32-bit integer)
```

### HAProxy Integration Flow

1. Request arrives with `Authorization: Bearer <api_key>`
2. HAProxy extracts API key, calls Lua script to decode it
3. Lua script decodes Base32 payload:
   - Extract metadata byte (byte 0)
   - Skip derivation (bytes 1-3)
   - Extract customer_id (bytes 4-7, 32-bit integer)
   - Extract service_type from key prefix
   - Verify HMAC-SHA256 signature
   - Return customer_id as sticky key
4. HAProxy stores customer_id in sticky table for rate limiting

**No database lookup required!**

### HAProxy Lua Implementation

```lua
-- HAProxy Lua script with HMAC validation
local openssl = require("openssl")

-- Secret key loaded from HAProxy config
local SECRET_KEY = core.get_var("txn.api_secret_key")

function validate_and_decode_api_key(api_key)
  -- Extract service type (first character)
  local service_char = api_key:sub(1, 1)  -- S, R, or G

  -- Extract payload (characters 2-21, always 20 chars)
  local payload_b32 = api_key:sub(2, 21)

  -- Extract checksum (last 4 chars, hex)
  local checksum_hex = api_key:sub(22, 25):upper()

  -- Decode Base32 payload (~20ns)
  local payload = base32_decode(payload_b32)

  -- Verify HMAC-SHA256 signature (~200ns)
  local hmac = openssl.hmac.new(SECRET_KEY, "sha256")
  hmac:update(payload)
  local signature = hmac:final()
  local expected_hex = signature:sub(1, 2):tohex():upper()  -- First 2 bytes to hex

  if checksum_hex ~= expected_hex then
    return nil, "invalid_signature"
  end

  -- Skip metadata byte (byte 0) and derivation (bytes 1-3)
  -- Extract customer ID (bytes 4-7)
  local customer_id = bytes_to_uint32(payload:sub(5, 8))

  -- Validate customer_id is not 0 (reserved value)
  if customer_id == 0 then
    return nil, "invalid_customer_id"
  end

  -- Return customer_id as string for sticky table
  return tostring(customer_id)
end
```

### Performance Metrics

```
HMAC validation in HAProxy Lua:
  - Base32 decode: ~20ns
  - HMAC-SHA256 verify: ~200ns
  - Customer ID extraction: ~10ns
  - Total: ~230ns per request

No external dependencies:
  - No network calls
  - No database queries
  - No external cache lookups
  - All processing in HAProxy Lua

Per million requests:
  - Total processing time: ~230ms (0.23 seconds)
  - Negligible overhead compared to network latency
```

### Revocation Checking

Use a two-tier approach for minimal performance impact:

```lua
-- HAProxy Lua with bloom filter for fast negative checks
local bloom_filter = require("bloom")  -- Pre-loaded bloom filter

function check_revoked(api_key)
  -- 1. Bloom filter check (99.9% of requests, ~5ns)
  if not bloom_filter:might_contain(api_key) then
    return false  -- Definitely not revoked
  end

  -- 2. Exact check only for potential positives (~0.1% of requests)
  local revoked = core.get_map("/etc/haproxy/revoked_keys.map")
  return revoked:lookup(api_key) ~= nil
end

-- In main validation function
if check_revoked(api_key) then
  return nil, "revoked"
end
```

**Bloom Filter Properties:**
- Size: 1MB supports ~1M revoked keys with 0.1% false positive rate
- Performance: ~5ns for negative checks (most common case)
- Updated every 5 minutes from database
- False positives only trigger exact check (no security impact)

**Updating revocation list:**
```bash
# Batch update via HAProxy Runtime API
cat revoked_keys.txt | \
  xargs -I {} echo "add map /etc/haproxy/revoked_keys.map {} 1" | \
  socat stdio /var/run/haproxy.sock

# Rebuild bloom filter (cron job every 5 minutes)
python3 rebuild_bloom.py > /etc/haproxy/bloom.dat
systemctl reload haproxy
```

**Performance Impact:**
- Non-revoked keys: +5ns (bloom filter check only)
- Recently revoked: +50ns (bloom + map lookup)
- Overall impact: <0.01% latency increase

## Security

### HMAC Authentication Prevents Forgery

- **Cannot create valid keys without SECRET_KEY**
- Even if attacker decodes a key and extracts customer_id + derivation
- They cannot generate new valid keys (HMAC signature will fail)
- Protects against the attack: "decode public key → guess privileged key"

**Attack scenario (now prevented):**
```
Attacker has: Public key SABCD...234567
Attacker decodes: customer_id=42, derivation=0
Attacker tries: derivation=1, 2, 3... (brute force)
Result: All attempts fail HMAC validation ✓
```

### Security Properties

1. **HMAC Authentication**: Cannot create valid keys without SECRET_KEY
2. **Customer ID exposure is acceptable**:
   - Customer ID is visible in decoded key (not secret)
   - But cannot be used to forge keys (HMAC protection)
   - **Random IDs prevent enumeration**: Can't guess other customer IDs
   - Internal numeric identifier (not PII)
   - Allows fast HAProxy decoding (~230ns)
   - Value 0 is reserved and rejected by validation

3. **Key uniqueness per master key group**:
   - Derivation is per master_key_group (not per customer)
   - Multiple customers can have same (group, derivation) pair
   - Each produces different API key due to different customer_id
   - HMAC ensures each key is cryptographically unique

4. **Revocation support**:
   - HAProxy shared memory for instant revocation
   - Updated via Runtime API (no restarts)
   - Revoked keys fail at HMAC validation layer
   - Database tracks is_active status for long-term storage

5. **Version support**: 2-bit version field allows protocol upgrades
   - Future versions can change HMAC algorithm or add features
   - Backward compatibility maintained through version detection

6. **Master key groups**: Support for 32 independent key hierarchies
   - Use case: Separate security domains, key rotation strategies
   - Each group has independent 16M derivation space

7. **Audit trail**: All key generation and usage logged with timestamps

### Secret Key Management

- SECRET_KEY must be securely stored (environment variable, secrets manager)
- Different keys for production/staging/development
- **Never rotate SECRET_KEY** - This would invalidate all issued API keys used by customer applications
- Use multiple `master_key_group` values for key isolation instead of SECRET_KEY rotation
- Never commit SECRET_KEY to version control
- Treat SECRET_KEY as a permanent, immutable secret once production keys are issued

## Database Schema

```sql
-- API Keys table
CREATE TABLE api_keys (
  api_key_id VARCHAR(100) PRIMARY KEY,     -- The full API key string
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  service_type VARCHAR(20) NOT NULL,       -- 'seal', 'grpc', 'graphql'
  seal_key_id UUID REFERENCES seal_keys(seal_key_id), -- For Seal service: which Seal Key this API key uses
  key_version SMALLINT NOT NULL,           -- Extracted from metadata byte (bits 7-6)
  is_imported BOOLEAN NOT NULL,            -- Extracted from metadata byte (bit 5)
  master_key_group SMALLINT NOT NULL,      -- Extracted from metadata byte (bits 4-0)
  derivation INTEGER,                      -- 3-byte index (0-16M), scope: per master_key_group
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP NULL,

  INDEX idx_customer_service (customer_id, service_type, is_active),
  INDEX idx_seal_key (seal_key_id, is_active),
  INDEX idx_group_derivation (master_key_group, derivation),
  CHECK (service_type != 'seal' OR seal_key_id IS NOT NULL) -- Seal service requires seal_key_id
);
```

**Relationship:**
- For **Seal service**: Each API key MUST reference a `seal_key_id` (identifies which Seal Key to use for signing)
- For **other services** (gRPC, GraphQL): `seal_key_id` is NULL (not applicable)
- A customer with 2 Seal Keys will have separate API keys for each Seal Key
- Multiple API keys can reference the same `seal_key_id` (for rotation/redundancy)

## API Operations

### Create Key (Rate Limited)

```typescript
POST /api/v1/services/{service_type}/keys
Authorization: Bearer <jwt_token>

// Rate limits:
// - Max 10 keys per seal key (for Seal service)
// - Max 5 key creations per hour per customer
// - Max derivation index: 1000 per customer (prevents exhaustion attacks)

Request:
{
  "seal_key_id": "uuid-here",  // REQUIRED for Seal service, identifies which Seal Key to use
  "is_imported": false,        // optional, default: false
  "master_key_group": 1        // optional, default: 1
}

Response:
{
  "api_key": "SABCDEFGHIJKLMNOPQRST234567",
  "seal_key_id": "uuid-here",
  "derivation": 0,
  "created_at": "2025-01-15T10:30:00Z",
  "service_type": "seal",
  "metadata": {
    "version": 0,
    "is_imported": false,
    "master_key_group": 1
  }
}

// Rate limit exceeded response:
{
  "error": "rate_limit_exceeded",
  "message": "Maximum 5 API keys can be created per hour",
  "retry_after": 2400  // seconds until next allowed
}
```

### List Keys

```typescript
GET /api/v1/services/{service_type}/keys
Authorization: Bearer <jwt_token>

// Optional query parameter for Seal service:
// ?seal_key_id=uuid-here  (filter by specific Seal Key)

Response:
{
  "keys": [
    {
      "key_prefix": "SABCD...234567",
      "seal_key_id": "uuid-1",
      "derivation": 0,
      "is_imported": false,
      "master_key_group": 1,
      "created_at": "2025-01-15T10:30:00Z",
      "is_active": true
    },
    {
      "key_prefix": "SEFGH...567234",
      "seal_key_id": "uuid-1",  // Same Seal Key, different API key
      "derivation": 1,
      "is_imported": false,
      "master_key_group": 1,
      "created_at": "2025-01-16T14:22:00Z",
      "is_active": true
    }
  ]
}
```

### Revoke Key

```typescript
DELETE /api/v1/services/{service_type}/keys/{derivation}
Authorization: Bearer <jwt_token>

Response:
{
  "success": true,
  "revoked_at": "2025-01-17T09:15:00Z"
}
```

## Multi-Service Support

### Service Independence

Each service type has its own namespace for API keys:

```
Customer X:
  - Seal API Keys: SABCDEFGHIJKLMNOPQRST234567, SEFGHIJKLMNOPQRSTUV345678
  - gRPC API Keys: RIJKLMNOPQRSTUVWXYZ456789, RMNOPQRSTUVWXYZABC567890
  - GraphQL API Keys: GQRSTUVWXYZABCDEFGH678901

Each service type has separate:
  - Rate limit buckets
  - Billing meters
  - Configuration
  - Sticky table keys
```

### Customer Sticky Key Generation

```typescript
// For single service (current): use customer_id directly
const stickyKey = customerId.toString();

// For multi-service (future): append service byte
const SERVICE_BYTES = {
  seal: 0x01,
  grpc: 0x02,
  graphql: 0x03
};

const sealStickyKey = customerId + ":" + SERVICE_BYTES.seal;
const grpcStickyKey = customerId + ":" + SERVICE_BYTES.grpc;
const graphqlStickyKey = customerId + ":" + SERVICE_BYTES.graphql;

// Examples:
// "42:1" → Customer 42, Seal service
// "42:2" → Customer 42, gRPC service
// "99:1" → Customer 99, Seal service
```

### Benefits of Service Isolation

- Service isolation (compromise of one doesn't affect others)
- Independent key rotation per service
- Service-specific rate limits and billing
- Clear audit trails per service

## Performance Targets

- **API key lookup**: <1ms (cached), <10ms (DB)
- **HAProxy sticky table resolution**: <1ms
- **Base32 decode**: ~20ns
- **HMAC-SHA256 verification**: ~200ns
- **Total HAProxy processing**: ~230ns per request

---

**Related Documents:**
- [CUSTOMER_SERVICE_SCHEMA.md](CUSTOMER_SERVICE_SCHEMA.md) - Customer and service schema
- [SEAL_SERVICE_CONFIG.md](SEAL_SERVICE_CONFIG.md) - Seal service configuration
- [GLOBAL_MANAGER_DESIGN.md](GLOBAL_MANAGER_DESIGN.md) - MA_VAULT generation

**Document Version**: 1.0
**Last Updated**: 2025-01-17
**Status**: Design specification (not yet implemented)
