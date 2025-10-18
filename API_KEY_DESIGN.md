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
  ┌──────────────┬─────────┬─────────────┬─────────┐
  │ key_metadata │ key_idx │ customer_id │ unused  │
  │ 1 byte       │ 1 byte  │ 4 bytes     │ 6 bytes │
  └──────────────┴─────────┴─────────────┴─────────┘

Key Metadata Byte (8 bits) - FIRST BYTE:
  ┌────────┬──────────────────┬────────┐
  │ version│ master_key_group │ unused │
  │ 2 bits │ 5 bits           │ 1 bit  │
  └────────┴──────────────────┴────────┘

  - Version: 00 (current), supports up to 4 versions
  - Master Key Group: 0-31 (5 bits) - Groups API keys by master key identity
  - Unused: Set to 0 (1 bit, LSB)

Key Index (1 byte):
  - 8-bit index (0-255 API keys per customer)
  - Makes API key unique for given customer_id
  - Used for metering and logging (distinguishes different API keys)
  - NOT related to Seal key selection (package_id in PTB selects Seal key)
  - Sequentially assigned: 0, 1, 2, ... when creating new API keys

Customer ID (4 bytes):
  - 32-bit random integer (1 to 4,294,967,295)
  - Cryptographically random (prevents enumeration attacks)
  - Value 0 is invalid
  - Collision probability negligible (< 0.023% with 1M customers)

Unused (6 bytes):
  - Set to zero
  - Available for future protocol extensions
  - Maintains consistent 12-byte payload for Base32 encoding
```

## Implementation

### Key Generation

```typescript
interface KeyMetadata {
  version: number;         // 0-3 (2 bits) - currently 0
  masterKeyGroup: number;  // 0-31 (5 bits) - groups API keys by master key
  // 1 bit unused (LSB)
}

interface ApiKeyPayload {
  metadata: KeyMetadata;  // 1 byte (offset 0)
  keyIdx: number;         // 1 byte (offset 1, 0-255)
  customerId: number;     // 4 bytes (offset 2-5)
  unused: Buffer;         // 6 bytes (offset 6-11, zeros)
}

// Encode metadata byte
function encodeMetadata(meta: KeyMetadata): number {
  return ((meta.version & 0b11) << 6) |          // bits 7-6: version
         ((meta.masterKeyGroup & 0b11111) << 1); // bits 5-1: master_key_group
                                                  // bit 0: unused (set to 0)
}

// Generate API key
function generateApiKey(
  customerId: number,
  serviceType: string,
  options: {
    keyIdx?: number;
    masterKeyGroup?: number;
  } = {}
): string {
  const payload = Buffer.alloc(12);

  // 1. Key metadata (1 byte) - offset 0
  const metadata = encodeMetadata({
    version: 0,
    masterKeyGroup: options.masterKeyGroup ?? 0
  });
  payload[0] = metadata;

  // 2. Key Index (1 byte) - offset 1
  payload[1] = options.keyIdx ?? 0;  // 0-255, for metering/logging

  // 3. Customer ID (4 bytes) - offset 2-5
  payload.writeUInt32BE(customerId, 2);

  // 4. Unused (6 bytes) - offset 6-11, set to zero
  // bytes 6-11: zeros (already initialized)

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
// Decode metadata byte
function decodeMetadata(byte: number): KeyMetadata {
  return {
    version: (byte >> 6) & 0b11,              // bits 7-6
    masterKeyGroup: (byte >> 1) & 0b11111,    // bits 5-1
    // bit 0: unused
  };
}

// Decode API key
function decodeApiKey(apiKey: string): {
  customerId: number;
  serviceType: string;
  metadata: KeyMetadata;
  keyIdx: number;
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

  // 2. Extract key_idx (offset 1, 1 byte)
  const keyIdx = payload[1];

  // 3. Extract customer ID (offset 2-5, 4 bytes)
  const customerId = payload.readUInt32BE(2);

  // 4. Unused bytes ignored (offset 6-11)

  return {
    customerId,
    serviceType,
    metadata,
    keyIdx,
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

## HAProxy Integration

### Fast Lookup Mechanism

**Challenge**: HAProxy sticky tables need a consistent key across all API keys for a customer.

**Solution**: Decode customer_id directly from the API key (no database lookup needed)

```
Sticky Table Key = customer_id

Properties:
  - Same for all API keys belonging to one customer
  - Extracted directly from API key payload (no DB query)
  - Extremely fast (~20ns for Base32 decode)
  - Stable (doesn't change when keys are rotated)
  - Compact (32-bit integer)
  - Multi-service: Use separate sticky tables per service type (not combined keys)
```

### HAProxy Integration Flow

1. Request arrives with `Authorization: Bearer <api_key>`
2. HAProxy extracts API key, calls Lua script to validate and decode it
3. Lua script validates API key (fail fast):
   - Extract service_type from first character (S, R, or G)
   - Extract Base32 payload (chars 2-21, 20 characters)
   - Extract hex checksum (chars 22-25, 4 characters)
   - Decode Base32 payload → 12 bytes
   - Verify HMAC-SHA256 checksum (using SECRET_KEY)
   - **If checksum invalid → reject immediately (authentication failed)**
4. Lua script extracts fields from validated payload:
   - Extract metadata byte (byte 0) - version and master_key_group
   - Extract key_idx (byte 1, 8-bit index)
   - Extract customer_id (bytes 2-5, 32-bit integer)
5. HAProxy adds custom headers:
   - `X-Suiftly-Customer-ID: <customer_id>` - For sticky table (rate limiting)
   - `X-Suiftly-Key-Idx: <key_idx>` - For metering/logging
   - `X-Suiftly-Master-Key-Group: <master_key_group>` - For grouping by master key
6. HAProxy forwards request to Seal key server backend
7. Seal key server processes standard `/v1/fetch_key` request:
   - **Customer provides PTB (Programmable Transaction Block)** calling `seal_approve*` function
   - **PTB specifies `package_id`** of the Move package (customer's application)
   - Seal server extracts `package_id` from PTB
   - **In permissioned mode:** Looks up `package_id` in `pkg_id_to_key` map → selects master key
   - Validates `package_id` access, evaluates `seal_approve*` policy (dry run)
   - Returns derived key using the selected `client_master_key`

**Simplified Flow:**
```
1. HAProxy validates API key (HMAC check)
2. HAProxy extracts customer_id, key_idx, master_key_group from API key payload
3. HAProxy adds headers: X-Suiftly-Customer-ID, X-Suiftly-Key-Idx, X-Suiftly-Master-Key-Group
4. HAProxy routes to Seal key server
5. Seal server extracts package_id from customer's PTB
6. Seal server looks up: pkg_id_to_key[package_id] → master_key
7. Seal server validates access policy (dry_run seal_approve* function)
8. Seal server returns derived key
```

**How MM_VAULT Config Works (key-server-config.yaml):**
```yaml
server_mode: !Permissioned
  client_configs:
    - name: "customer_12345_seal_key_1"
      client_master_key: !Derived
        derivation_index: 1001           # Unique per customer Seal key
      key_server_object_id: "0xabc..."   # On-chain registration
      package_ids:
        - "0x123..."                     # Customer's Move package ID(s)

    - name: "customer_99999_seal_key_1"
      client_master_key: !Imported
        env_var: "CUSTOMER_99999_KEY"
      key_server_object_id: "0xdef..."
      package_ids:
        - "0x456..."
```

**Key Selection Mechanism:**
- Customer provides `package_id` in their PTB (identifies their application)
- Seal server maps: `pkg_id_to_key[package_id]` → master_key
- Each customer's `package_id`(s) map to their Seal key master key
- API key's `key_idx` is for metering/logging only (not key selection)

**No database lookup required for authentication!** Key selection via `package_id` in customer's PTB.

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

  -- Extract metadata byte (byte 0, offset 1 in Lua 1-based indexing)
  local metadata_byte = payload:byte(1)
  local version = bit32.rshift(metadata_byte, 6)  -- bits 7-6
  local master_key_group = bit32.band(bit32.rshift(metadata_byte, 1), 0x1F)  -- bits 5-1

  -- Extract key_idx (byte 1, offset 2 in Lua)
  local key_idx = payload:byte(2)

  -- Extract customer ID (bytes 2-5, offset 3-6 in Lua 1-based indexing)
  local customer_id = bytes_to_uint32(payload:sub(3, 6))

  -- Validate customer_id is not 0 (reserved value)
  if customer_id == 0 then
    return nil, "invalid_customer_id"
  end

  -- Return extracted fields
  return tostring(customer_id), tostring(key_idx), tostring(master_key_group)
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
  key_version SMALLINT NOT NULL,           -- Extracted from metadata byte (bits 7-6)
  master_key_group SMALLINT NOT NULL,      -- Extracted from metadata byte (bits 5-1)
  key_idx SMALLINT NOT NULL,               -- Extracted from byte 1 (0-255), for metering/logging
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP NULL,

  INDEX idx_customer_service (customer_id, service_type, is_active),
  INDEX idx_customer_key_idx (customer_id, key_idx),  -- Lookup for metering/logging
  UNIQUE (customer_id, key_idx)  -- Ensure key_idx is unique per customer
);
```

**Key Points:**
- `key_idx` makes each API key unique for a given customer (for metering/logging purposes)
- `master_key_group` groups API keys by master key identity (5 bits = 0-31 groups)
- For **Seal service**: Key selection is determined by `package_id` in customer's PTB (not by API key)
- `key_idx` is sequentially assigned: 0, 1, 2, ... when creating new API keys for a customer

## API Operations

### Create Key (Rate Limited)

```typescript
POST /api/v1/services/{service_type}/keys
Authorization: Bearer <jwt_token>

// Rate limits:
// - Max 256 keys per customer (0-255 key_idx range)
// - Max 5 key creations per hour per customer

Request:
{
  "master_key_group": 0        // optional, default: 0 (0-31 valid range)
}

Response:
{
  "api_key": "SABCDEFGHIJKLMNOPQRST234567",
  "key_idx": 0,                // Auto-assigned index (0-255)
  "created_at": "2025-01-15T10:30:00Z",
  "service_type": "seal",
  "metadata": {
    "version": 0,
    "master_key_group": 0
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

Response:
{
  "keys": [
    {
      "key_prefix": "SABCD...234567",
      "key_idx": 0,
      "master_key_group": 0,
      "created_at": "2025-01-15T10:30:00Z",
      "is_active": true
    },
    {
      "key_prefix": "SEFGH...567234",
      "key_idx": 1,
      "master_key_group": 0,
      "created_at": "2025-01-16T14:22:00Z",
      "is_active": true
    }
  ]
}
```

### Revoke Key

```typescript
DELETE /api/v1/services/{service_type}/keys/{api_key_id}
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

### Rate Limiting Strategy

**Per-Service Sticky Tables:**

Each service type uses its own HAProxy sticky table for rate limiting:

```
# HAProxy configuration (conceptual)

# Seal service sticky table
stick-table type string len 16 size 100k expire 1h store http_req_rate(10s)

# gRPC service sticky table (future)
stick-table type string len 16 size 100k expire 1h store http_req_rate(10s)

# GraphQL service sticky table (future)
stick-table type string len 16 size 100k expire 1h store http_req_rate(10s)
```

**Sticky Key per Service:**
```typescript
// Extract customer_id from API key
const customerId = decodeApiKey(apiKey).customerId;

// Use customer_id as sticky key (simple, clean)
const stickyKey = customerId.toString();

// Examples:
// Seal request from customer 42 → sticky key "42" in seal_sticky_table
// gRPC request from customer 42 → sticky key "42" in grpc_sticky_table
// Different tables = independent rate limits per service
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
