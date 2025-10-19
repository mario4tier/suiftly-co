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
  <service><interleaved_payload_and_hmac>

Example:
  SABCDEFGHIJKLMNOPQRSTUVWXYZ1234
  │└─────────── 30 chars ───────────┘
  │         (payload + HMAC interleaved)
  Service type

Components:
  - Service: Single uppercase character (S=Seal, R=gRPC, G=GraphQL)
  - Interleaved: 30 characters with Base32 ciphertext and hex HMAC tag mixed
    * Base32 ciphertext: 26 chars (encrypted 16-byte payload)
    * HMAC tag: 4 chars hex (2-byte authentication tag)
    * Interleaved using reversible swap pattern (obfuscation)

Service Type Identifiers:
  - S → Seal service
  - R → gRPC service (future)
  - G → GraphQL service (future)

Total Length: 31 characters (fixed)

Note: The HMAC tag is interleaved into specific positions within the Base32
ciphertext to obscure the structure and make reverse engineering slower.
```

### Encryption Design

**Encryption Algorithm:** AES-128-CTR (Counter Mode)
**Authentication:** HMAC-SHA256 (Encrypt-then-MAC)
**Payload Size:** 16 bytes (128 bits, optimal AES block alignment)

**Why AES-128-CTR:**
- ✅ **Hardware accelerated** - AES-NI on x86 servers (~50ns decrypt)
- ✅ **Fixed-size output** - Ciphertext = plaintext size (no padding)
- ✅ **Stream cipher mode** - No block padding overhead
- ✅ **Fast in HAProxy Lua** - Native OpenSSL support
- ✅ **16-byte alignment** - Optimal for AES hardware acceleration

**Why HMAC-SHA256 (2-byte tag):**
- ✅ **Fast authentication** - ~100ns in HAProxy
- ✅ **Compact** - 2 bytes sufficient for API key use case (1/65536 collision)
- ✅ **Combined with rate limiting** - Failed attempts logged and blocked
- ✅ **Encrypt-then-MAC** - Industry-standard secure construction

**Total HAProxy Performance:** ~180ns (Base32 decode + AES decrypt + HMAC verify)

**Nonce Strategy:** Fixed nonce derived from SECRET_KEY
- Deterministic: `HMAC-SHA256(SECRET_KEY, "SUIFTLY_API_KEY_NONCE_V1")` → first 16 bytes
- Safe for CTR mode: Each payload is unique (customer_id + key_idx combination)
- No nonce reuse risk: Unique plaintexts produce unique ciphertexts
- No storage overhead: Nonce not included in API key

### HMAC Interleaving (Obfuscation)

To make the API key structure less obvious and slow down reverse engineering, the 4-character HMAC tag is interleaved into the 26-character Base32 ciphertext using a reversible swap pattern.

**Purpose:**
- Eliminate obvious hex vs Base32 boundary
- Mix hex characters (0-9, A-F) into Base32 characters (A-Z, 2-7)
- Make automatic pattern detection harder
- Slow down casual reverse engineering attempts

**Interleaving Pattern (0-based indexing):**
```
Combined string: [26 Base32 chars] + [4 hex chars] = 30 chars total

Swap operations (reversible):
  Position 1  ↔ Position 26  (2nd payload char ↔ 1st HMAC char)
  Position 6  ↔ Position 29  (7th payload char ↔ 4th HMAC char)
  Position 20 ↔ Position 27  (21st payload char ↔ 2nd HMAC char)
  Position 13 ↔ Position 28  (14th payload char ↔ 3rd HMAC char)
```

**Example:**
```
Before interleaving:
  Payload: ABCDEFGHIJKLMNOPQRSTUVWXYZ  (26 chars, Base32)
  HMAC:    1234                        (4 chars, hex)

After interleaving (positions 1, 6, 20, 13 swapped with 26, 29, 27, 28):
  A1CDEF4HIJKLM3OPQRST2VWXYZBUNG

Result: Hex digits (1,2,3,4) now appear scattered in positions 1, 6, 13, 20
        Original chars (B, G, N, U) moved to end positions 26, 29, 28, 27
```

### Plaintext Payload Structure (16 bytes, before encryption)

**Note:** This payload structure is defined for the **Seal service**. Future services (gRPC, GraphQL) may use different payload structures while maintaining the same overall API key format (service prefix + 26-char encrypted payload + 4-char HMAC tag).

```
Seal Service Plaintext Payload (16 bytes):
  ┌──────────────┬─────────┬─────────────┬─────────┐
  │ key_metadata │ key_idx │ customer_id │  unused │
  │ 2 bytes      │ 2 bytes │ 4 bytes     │ 8 bytes │
  └──────────────┴─────────┴─────────────┴─────────┘

Key Metadata (2 bytes, 16 bits) - BYTES 0-1:
  ┌────────┬───────────┬──────────────────┬────────┐
  │ version│ seal_type │ master_key_group │ unused │
  │ 2 bits │ 3 bits    │ 3 bits           │ 8 bits │
  └────────┴───────────┴──────────────────┴────────┘

  - Version: 00 (current), supports up to 4 versions
  - Seal Type: 3 bits (abc) - Seal key configuration:
    * a (bit 12): Network - 1=mainnet, 0=testnet
    * b (bit 11): Access - 1=permission, 0=open
    * c (bit 10): Source (when permission) - 1=imported, 0=derived
                  (unused when open)

    All 8 possible seal_type values:
    ┌─────┬─────────┬────────────┬──────────┬────────────────────────────────┐
    │ abc │ Network │ Access     │ Source   │ Status                         │
    ├─────┼─────────┼────────────┼──────────┼────────────────────────────────┤
    │ 000 │ testnet │ open       │ derived  │ Undefined (reserved)           │
    │ 001 │ testnet │ open       │ imported │ Valid (testnet/open)           │
    │ 010 │ testnet │ permission │ derived  │ Valid (testnet/permission/der) │
    │ 011 │ testnet │ permission │ imported │ Valid (testnet/permission/imp) │
    │ 100 │ mainnet │ open       │ derived  │ Undefined (reserved)           │
    │ 101 │ mainnet │ open       │ imported │ Valid (mainnet/open)           │
    │ 110 │ mainnet │ permission │ derived  │ Valid (mainnet/permission/der) │
    │ 111 │ mainnet │ permission │ imported │ Valid (mainnet/permission/imp) │
    └─────┴─────────┴────────────┴──────────┴────────────────────────────────┘

    Note: For open access (b=0), the source bit (c) is ignored in practice.
          Values 000 and 100 are undefined/reserved for future use.
  - Master Key Group: 0-7 (3 bits) - Groups API keys by master key identity
  - Unused: Set to 0 (8 bits reserved for future use)

Key Index (2 bytes, 16 bits) - BYTES 2-3:
  - 16-bit index (0-65535 API keys per customer)
  - Allows for index recycling when combined with rate limiting and pruning
  - Makes API key unique for given customer_id
  - Used for metering and logging (distinguishes different API keys)
  - NOT related to Seal key selection (package_id in PTB selects Seal key)
  - Sequentially assigned: 0, 1, 2, ... when creating new API keys

Customer ID (4 bytes, 32 bits) - BYTES 4-7:
  - 32-bit random integer (1 to 4,294,967,295)
  - Cryptographically random (prevents enumeration attacks)
  - Value 0 is invalid
  - Collision probability negligible (< 0.023% with 1M customers)
  - **Encrypted** - Not visible to anyone holding the API key

Unused (8 bytes) - BYTES 8-15:
  - Set to zero
  - Available for future protocol extensions
  - Maintains optimal 16-byte payload size (128 bits, 1 AES block)
```

## Implementation

### Key Generation

```typescript
interface SealType {
  network: 'mainnet' | 'testnet';     // bit 12: 1=mainnet, 0=testnet
  access: 'permission' | 'open';      // bit 11: 1=permission, 0=open
  source?: 'imported' | 'derived';    // bit 10: 1=imported, 0=derived (only when permission)
}

interface KeyMetadata {
  version: number;         // 0-3 (2 bits) - currently 0
  sealType: SealType;      // 3 bits (abc) - seal key configuration
  masterKeyGroup: number;  // 0-7 (3 bits) - groups API keys by master key
  // 8 bits unused (reserved for future use)
}

interface ApiKeyPayload {
  metadata: KeyMetadata;  // 2 bytes (offset 0-1)
  keyIdx: number;         // 2 bytes (offset 2-3, 0-65535)
  customerId: number;     // 4 bytes (offset 4-7)
  unused: Buffer;         // 8 bytes (offset 8-15, zeros)
}

// Encode seal_type (3 bits)
function encodeSealType(sealType: SealType): number {
  const a = sealType.network === 'mainnet' ? 1 : 0;  // bit 12
  const b = sealType.access === 'permission' ? 1 : 0; // bit 11
  const c = sealType.access === 'permission' && sealType.source === 'imported' ? 1 : 0; // bit 10

  // Validate unsupported combinations
  if (a === 1 && b === 0 && c === 1) {
    throw new Error('Invalid seal_type: 100 is an unsupported configuration');
  }
  if (a === 0 && b === 0 && c === 0) {
    throw new Error('Invalid seal_type: 000 is an unsupported configuration');
  }

  return (a << 2) | (b << 1) | c;  // 3-bit value
}

// Encode metadata (2 bytes, big-endian)
function encodeMetadata(meta: KeyMetadata): number {
  const sealTypeBits = encodeSealType(meta.sealType);

  return ((meta.version & 0b11) << 14) |              // bits 15-14: version
         ((sealTypeBits & 0b111) << 11) |             // bits 13-11: seal_type
         ((meta.masterKeyGroup & 0b111) << 8);        // bits 10-8: master_key_group
                                                       // bits 7-0: unused (set to 0)
}

// Derive fixed nonce from SECRET_KEY (for AES-128-CTR)
let FIXED_NONCE: Buffer | null = null;
function getFixedNonce(): Buffer {
  if (!FIXED_NONCE) {
    const hmac = crypto.createHmac('sha256', SECRET_KEY);
    hmac.update('SUIFTLY_API_KEY_NONCE_V1');
    FIXED_NONCE = hmac.digest().slice(0, 16);  // First 16 bytes
  }
  return FIXED_NONCE;
}

// Interleave HMAC tag into Base32 payload (reversible swap for obfuscation)
// This makes the structure less obvious by mixing hex chars into Base32 chars
function interleaveHmacTag(payload: string, tag: string): string {
  // payload: 26 chars Base32 (A-Z, 2-7)
  // tag: 4 chars hex (0-9, A-F)
  // Returns: 30 chars with HMAC interleaved

  // Combine into single string, then swap specific positions
  const combined = payload + tag;  // 30 chars total
  const chars = combined.split('');

  // Swap pattern (0-based indexing):
  // Position 1 (2nd char of payload) ↔ Position 26 (1st char of HMAC - tag[0])
  // Position 6 (7th char of payload) ↔ Position 29 (4th char of HMAC - tag[3])
  // Position 20 (21st char of payload) ↔ Position 27 (2nd char of HMAC - tag[1])
  // Position 13 (14th char of payload) ↔ Position 28 (3rd char of HMAC - tag[2])

  [chars[1], chars[26]] = [chars[26], chars[1]];   // Swap payload[1] ↔ tag[0]
  [chars[6], chars[29]] = [chars[29], chars[6]];   // Swap payload[6] ↔ tag[3]
  [chars[20], chars[27]] = [chars[27], chars[20]]; // Swap payload[20] ↔ tag[1]
  [chars[13], chars[28]] = [chars[28], chars[13]]; // Swap payload[13] ↔ tag[2]

  return chars.join('');  // Return 30 chars
}

// Generate API key
function generateApiKey(
  customerId: number,
  serviceType: string,
  options: {
    keyIdx?: number;
    sealType?: SealType;
    masterKeyGroup?: number;
  } = {}
): string {
  // 1. Build 16-byte plaintext payload
  const plaintext = Buffer.alloc(16);

  const metadata = encodeMetadata({
    version: 0,
    sealType: options.sealType ?? { network: 'testnet', access: 'open' },
    masterKeyGroup: options.masterKeyGroup ?? 0
  });
  plaintext.writeUInt16BE(metadata, 0);         // offset 0-1: metadata (2 bytes)
  plaintext.writeUInt16BE(options.keyIdx ?? 0, 2); // offset 2-3: key_idx (2 bytes)
  plaintext.writeUInt32BE(customerId, 4);       // offset 4-7: customer_id (4 bytes)
  // bytes 8-15: unused (zeros)

  // 2. Encrypt with AES-128-CTR
  const nonce = getFixedNonce();
  const cipher = crypto.createCipheriv(
    'aes-128-ctr',
    SECRET_KEY.slice(0, 16),  // First 16 bytes of SECRET_KEY for AES-128
    nonce
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);  // 16 bytes

  // 3. Authenticate with HMAC-SHA256 (Encrypt-then-MAC)
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(ciphertext);
  const tag = hmac.digest().slice(0, 2);  // First 2 bytes

  // 4. Encode: Base32(ciphertext) + Hex(tag)
  const base32Ciphertext = base32Encode(ciphertext);  // 26 chars
  const hexTag = tag.toString('hex').toUpperCase();   // 4 chars

  // 5. Interleave HMAC tag into payload (obfuscation)
  const interleaved = interleaveHmacTag(base32Ciphertext, hexTag);  // 30 chars

  // 6. Format: <service><interleaved>
  const serviceChar = serviceTypeToChar(serviceType);
  return `${serviceChar}${interleaved}`;  // 31 chars total
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
// Decode seal_type (3 bits)
function decodeSealType(sealTypeBits: number): SealType {
  const a = (sealTypeBits >> 2) & 1;  // bit 12 (network)
  const b = (sealTypeBits >> 1) & 1;  // bit 11 (access)
  const c = sealTypeBits & 1;         // bit 10 (source)

  const network = a === 1 ? 'mainnet' : 'testnet';
  const access = b === 1 ? 'permission' : 'open';
  const source = (b === 1 && c === 1) ? 'imported' :
                 (b === 1 && c === 0) ? 'derived' :
                 undefined;

  return { network, access, source } as SealType;
}

// Decode metadata (2 bytes, big-endian)
function decodeMetadata(value: number): KeyMetadata {
  const sealTypeBits = (value >> 11) & 0b111;  // bits 13-11

  return {
    version: (value >> 14) & 0b11,              // bits 15-14
    sealType: decodeSealType(sealTypeBits),     // bits 13-11
    masterKeyGroup: (value >> 8) & 0b111,       // bits 10-8
    // bits 7-0: unused
  };
}

// Decode API key
function decodeApiKey(apiKey: string): {
  customerId: number;
  serviceType: string;
  metadata: KeyMetadata;
  keyIdx: number;
} {
  // 1. Extract service char (first character)
  const serviceChar = apiKey[0];
  const serviceType = charToServiceType(serviceChar);

  // 2. Extract interleaved string (30 chars)
  const interleaved = apiKey.slice(1);  // Characters 1-30

  // 3. De-interleave to separate payload and HMAC tag
  // (Same function works for both directions - it's a reversible swap)
  const deinterleaved = interleaveHmacTag(
    interleaved.slice(0, 26),
    interleaved.slice(26)
  );
  const base32Ciphertext = deinterleaved.slice(0, 26);  // Base32 payload
  const tagHex = deinterleaved.slice(26);                // 4 hex chars

  // 4. Decode Base32 ciphertext
  const ciphertext = base32Decode(base32Ciphertext);  // 16 bytes

  // 5. Verify HMAC-SHA256 authentication tag (Encrypt-then-MAC)
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(ciphertext);
  const expectedTag = hmac.digest().slice(0, 2);
  const expectedTagHex = expectedTag.toString('hex').toUpperCase();

  if (tagHex.toUpperCase() !== expectedTagHex) {
    throw new Error('Invalid API key - authentication failed');
  }

  // 6. Decrypt with AES-128-CTR
  const nonce = getFixedNonce();
  const decipher = crypto.createDecipheriv(
    'aes-128-ctr',
    SECRET_KEY.slice(0, 16),  // First 16 bytes of SECRET_KEY for AES-128
    nonce
  );
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);  // 16 bytes

  // 7. Extract fields from plaintext
  const metadata = decodeMetadata(plaintext.readUInt16BE(0)); // offset 0-1 (2 bytes)
  const keyIdx = plaintext.readUInt16BE(2);                   // offset 2-3 (2 bytes)
  const customerId = plaintext.readUInt32BE(4);               // offset 4-7 (4 bytes)
  // bytes 8-15: unused (ignored)

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

**Ciphertext (26 chars):** Base32 encoding
- **Fast decode performance**: ~20ns vs Base58's ~200ns
- **Fixed length encoding**: Always 26 chars for 16 bytes
- **No ambiguous characters**: Uses A-Z, 2-7 only
- **Case-insensitive**: Easier to read/type
- **Standard encoding**: RFC 4648 with excellent library support

**HMAC Tag (4 chars):** Hex encoding (uppercase)
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

**Solution**: Decrypt and decode customer_id directly from the API key (no database lookup needed)

```
Sticky Table Key = customer_id

Properties:
  - Same for all API keys belonging to one customer
  - Extracted from encrypted API key payload (no DB query)
  - Extremely fast (~180ns: Base32 decode + AES decrypt + HMAC verify)
  - Stable (doesn't change when keys are rotated)
  - Compact (32-bit integer)
  - Multi-service: Use separate sticky tables per service type (not combined keys)
```

### HAProxy Integration Flow

1. Request arrives with `Authorization: Bearer <api_key>`
2. HAProxy extracts API key, calls Lua script to decrypt and validate it
3. Lua script validates and decrypts API key (fail fast):
   - Extract service_type from first character (S, R, or G)
   - Extract Base32 ciphertext (chars 2-27, 26 characters)
   - Extract hex HMAC tag (chars 28-31, 4 characters)
   - Decode Base32 ciphertext → 16 bytes
   - Verify HMAC-SHA256 tag on ciphertext (using SECRET_KEY)
   - **If HMAC invalid → reject immediately (authentication failed)**
   - Decrypt ciphertext with AES-128-CTR (using SECRET_KEY and fixed nonce)
4. Lua script extracts fields from decrypted plaintext:
   - Extract metadata (bytes 0-1, 16 bits) - version, seal_type, and master_key_group
   - Extract key_idx (bytes 2-3, 16-bit index)
   - Extract customer_id (bytes 4-7, 32-bit integer)
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
1. HAProxy validates API key (HMAC check + AES-128-CTR decryption)
2. HAProxy extracts customer_id, key_idx, master_key_group from decrypted plaintext
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
-- HAProxy Lua script with AES-128-CTR + HMAC validation
local openssl = require("openssl")

-- Secret key loaded from HAProxy config
local SECRET_KEY = core.get_var("txn.api_secret_key")

-- Derive fixed nonce from SECRET_KEY (cached globally)
local FIXED_NONCE = nil
function get_fixed_nonce()
  if not FIXED_NONCE then
    local hmac = openssl.hmac.new(SECRET_KEY, "sha256")
    hmac:update("SUIFTLY_API_KEY_NONCE_V1")
    FIXED_NONCE = hmac:final():sub(1, 16)  -- First 16 bytes
  end
  return FIXED_NONCE
end

-- Helper: Convert 2 bytes to uint16 (big-endian)
function bytes_to_uint16(bytes)
  local b1, b2 = bytes:byte(1, 2)
  return bit32.bor(bit32.lshift(b1, 8), b2)
end

-- Helper: Convert 4 bytes to uint32 (big-endian)
function bytes_to_uint32(bytes)
  local b1, b2, b3, b4 = bytes:byte(1, 4)
  return bit32.bor(
    bit32.lshift(b1, 24),
    bit32.lshift(b2, 16),
    bit32.lshift(b3, 8),
    b4
  )
end

-- Interleave/de-interleave HMAC tag (reversible swap for obfuscation)
function interleave_hmac_tag(payload, tag)
  -- payload: 26 chars, tag: 4 chars → returns 30 chars
  -- Swap pattern: positions 1↔26, 6↔29, 20↔27, 13↔28 (0-based)

  local chars = {}
  local combined = payload .. tag
  for i = 1, #combined do
    chars[i] = combined:sub(i, i)
  end

  -- Perform swaps (Lua is 1-based, so add 1 to indices)
  chars[2], chars[27] = chars[27], chars[2]    -- pos 1 ↔ pos 26
  chars[7], chars[30] = chars[30], chars[7]    -- pos 6 ↔ pos 29
  chars[21], chars[28] = chars[28], chars[21]  -- pos 20 ↔ pos 27
  chars[14], chars[29] = chars[29], chars[14]  -- pos 13 ↔ pos 28

  return table.concat(chars)
end

function validate_and_decode_api_key(api_key)
  -- 1. Extract service type (first character)
  local service_char = api_key:sub(1, 1)  -- S, R, or G

  -- 2. Extract interleaved string (characters 2-31, 30 chars)
  local interleaved = api_key:sub(2, 31)

  -- 3. De-interleave to separate payload and HMAC tag
  local deinterleaved = interleave_hmac_tag(
    interleaved:sub(1, 26),
    interleaved:sub(27, 30)
  )
  local ciphertext_b32 = deinterleaved:sub(1, 26)  -- Base32 payload
  local tag_hex = deinterleaved:sub(27, 30):upper()  -- 4 hex chars

  -- 4. Decode Base32 ciphertext (~20ns)
  local ciphertext = base32_decode(ciphertext_b32)  -- 16 bytes

  -- 5. Verify HMAC-SHA256 tag on ciphertext (~100ns)
  local hmac = openssl.hmac.new(SECRET_KEY, "sha256")
  hmac:update(ciphertext)
  local expected_tag = hmac:final()
  local expected_hex = expected_tag:sub(1, 2):tohex():upper()  -- First 2 bytes to hex

  if tag_hex ~= expected_hex then
    return nil, "invalid_authentication_tag"
  end

  -- 6. Decrypt with AES-128-CTR (~50ns)
  local nonce = get_fixed_nonce()
  local cipher = openssl.cipher.new("aes-128-ctr")
  cipher:decrypt(SECRET_KEY:sub(1, 16), nonce)  -- First 16 bytes of SECRET_KEY
  local plaintext = cipher:update(ciphertext) .. cipher:final()  -- 16 bytes

  -- 7. Extract fields from plaintext
  -- Metadata: 2 bytes (big-endian) at offset 0-1
  local metadata = bytes_to_uint16(plaintext:sub(1, 2))
  local version = bit32.rshift(metadata, 14)  -- bits 15-14

  -- Seal type: 3 bits (bits 13-11)
  local seal_type_bits = bit32.band(bit32.rshift(metadata, 11), 0x7)
  local seal_network = bit32.band(bit32.rshift(seal_type_bits, 2), 1)  -- bit a (mainnet=1, testnet=0)
  local seal_access = bit32.band(bit32.rshift(seal_type_bits, 1), 1)   -- bit b (permission=1, open=0)
  local seal_source = bit32.band(seal_type_bits, 1)                    -- bit c (imported=1, derived=0)

  local master_key_group = bit32.band(bit32.rshift(metadata, 8), 0x7)  -- bits 10-8

  -- Key index: 2 bytes (big-endian) at offset 2-3
  local key_idx = bytes_to_uint16(plaintext:sub(3, 4))

  -- Customer ID: 4 bytes (big-endian) at offset 4-7
  local customer_id = bytes_to_uint32(plaintext:sub(5, 8))

  -- 8. Validate customer_id is not 0 (reserved value)
  if customer_id == 0 then
    return nil, "invalid_customer_id"
  end

  -- Return extracted fields
  return tostring(customer_id), tostring(key_idx), tostring(master_key_group),
         tostring(seal_network), tostring(seal_access), tostring(seal_source)
end
```

### Performance Metrics

```
API key decryption and validation in HAProxy Lua:
  - Base32 decode: ~20ns
  - HMAC-SHA256 verify: ~100ns
  - AES-128-CTR decrypt: ~50ns (hardware accelerated with AES-NI)
  - Field extraction: ~10ns
  - Total: ~180ns per request

No external dependencies:
  - No network calls
  - No database queries
  - No external cache lookups
  - All processing in HAProxy Lua

Per million requests:
  - Total processing time: ~180ms (0.18 seconds)
  - Negligible overhead compared to network latency
  - ~5.5 million requests/sec/core throughput
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

### Encryption and Authentication (Defense in Depth)

**AES-128-CTR Encryption:**
- **Confidentiality**: customer_id, key_idx, and master_key_group are encrypted
- **Cannot read payload without SECRET_KEY**
- Even if API key is exposed in logs, data remains confidential
- Hardware-accelerated AES-NI for performance

**HMAC-SHA256 Authentication (Encrypt-then-MAC):**
- **Integrity**: Cannot modify ciphertext without detection
- **Authentication**: Cannot create valid keys without SECRET_KEY
- **Prevents forgery**: Attacker cannot generate valid API keys
- Industry-standard secure construction

**Attack scenarios (all prevented):**
```
1. Data Exposure Attack:
   Attacker has: API key from logs SABCD...1234
   Attacker tries: Decode to extract customer_id
   Result: Only sees encrypted ciphertext ✓

2. Forgery Attack:
   Attacker tries: Create new API key with guessed customer_id
   Result: HMAC validation fails (no SECRET_KEY) ✓

3. Modification Attack:
   Attacker tries: Modify ciphertext to change customer_id
   Result: HMAC validation fails (tampered data) ✓

4. Replay Attack:
   Attacker tries: Reuse valid API key
   Result: Works (expected) - revoke via revocation list if needed ✓
```

### Security Properties

1. **Encryption**: Customer data (customer_id, key_idx) is encrypted
   - **AES-128-CTR** with fixed nonce (safe: unique plaintexts)
   - Data confidentiality even if API key is exposed
   - Cannot extract customer_id without SECRET_KEY

2. **Authentication**: HMAC-SHA256 prevents forgery and tampering
   - Cannot create valid keys without SECRET_KEY
   - Cannot modify ciphertext without detection
   - 16-bit tag sufficient with rate limiting (1/65536 collision probability)

3. **Random Customer IDs**: Prevents enumeration attacks
   - 32-bit cryptographically random integers (not sequential)
   - Cannot guess other customer IDs
   - Encrypted in API key (not visible)

4. **Key uniqueness**: Each (customer_id, key_idx) pair is unique
   - key_idx allows multiple API keys per customer
   - Different keys for same customer have different encrypted payloads
   - Each produces unique ciphertext (CTR mode with unique plaintext)

5. **Revocation support**:
   - HAProxy shared memory for instant revocation
   - Updated via Runtime API (no restarts)
   - Revoked keys fail at authentication layer
   - Database tracks is_active status for long-term storage

6. **Version support**: 2-bit version field allows protocol upgrades
   - Future versions can change encryption/authentication algorithms
   - Backward compatibility maintained through version detection

7. **Master key groups**: Support for 32 independent key hierarchies
   - Use case: Separate security domains, key rotation strategies
   - Encrypted within payload (not exposed)

8. **Audit trail**: All key generation and usage logged with timestamps

### Secret Key Management

**SECRET_KEY Requirements:**
- **Minimum length**: 32 bytes (256 bits) for security
  - First 16 bytes used for AES-128 encryption key
  - Full 32 bytes used for HMAC-SHA256
- **Secure storage**: Environment variable or secrets manager (never in code)
- **Different keys**: Separate for production/staging/development
- **Never commit**: Exclude from version control

**CRITICAL - Never Rotate in Production:**
- **Never rotate SECRET_KEY** once production API keys are issued
- Rotation would invalidate ALL customer API keys immediately
- Customer applications cannot be re-issued keys automatically
- Treat SECRET_KEY as a permanent, immutable secret

**Key Isolation Strategy:**
- Use `master_key_group` field (0-31) for logical key separation
- Different groups for different security domains
- Does not require SECRET_KEY rotation

## Database Schema

```sql
-- API Keys table
CREATE TABLE api_keys (
  api_key_id VARCHAR(100) PRIMARY KEY,     -- The full API key string
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  service_type VARCHAR(20) NOT NULL,       -- 'seal', 'grpc', 'graphql'
  key_version SMALLINT NOT NULL,           -- Extracted from metadata (bits 15-14)
  seal_network SMALLINT NOT NULL,          -- Extracted from seal_type bit a (1=mainnet, 0=testnet)
  seal_access SMALLINT NOT NULL,           -- Extracted from seal_type bit b (1=permission, 0=open)
  seal_source SMALLINT,                    -- Extracted from seal_type bit c (1=imported, 0=derived, NULL=open)
  master_key_group SMALLINT NOT NULL,      -- Extracted from metadata (bits 10-8, 0-7)
  key_idx INTEGER NOT NULL,                -- Extracted from bytes 2-3 (0-65535), for metering/logging
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
- `seal_network`, `seal_access`, `seal_source` describe the Seal key configuration
- `master_key_group` groups API keys by master key identity (3 bits = 0-7 groups)
- For **Seal service**: Key selection is determined by `package_id` in customer's PTB (not by API key)
- `key_idx` is sequentially assigned: 0, 1, 2, ... when creating new API keys for a customer

## API Operations

### Create Key (Rate Limited)

```typescript
POST /api/v1/services/{service_type}/keys
Authorization: Bearer <jwt_token>

// Rate limits:
// - Max 65536 keys per customer (0-65535 key_idx range, allows index recycling)
// - Max 5 key creations per hour per customer

Request:
{
  "seal_type": {               // optional, default: { network: "testnet", access: "open" }
    "network": "mainnet",      // "mainnet" or "testnet"
    "access": "permission",    // "permission" or "open"
    "source": "derived"        // "imported" or "derived" (only when access="permission")
  },
  "master_key_group": 0        // optional, default: 0 (0-7 valid range)
}

Response:
{
  "api_key": "SABCDEFGHIJKLMNOPQRST234567",
  "key_idx": 0,                // Auto-assigned index (0-65535)
  "created_at": "2025-01-15T10:30:00Z",
  "service_type": "seal",
  "metadata": {
    "version": 0,
    "seal_type": {
      "network": "mainnet",
      "access": "permission",
      "source": "derived"
    },
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
- [CUSTOMER_SERVICE_SCHEMA.md](./CUSTOMER_SERVICE_SCHEMA.md) - Customer and service schema
- [SEAL_SERVICE_CONFIG.md](./SEAL_SERVICE_CONFIG.md) - Seal service configuration
- [GLOBAL_MANAGER_DESIGN.md](./GLOBAL_MANAGER_DESIGN.md) - MA_VAULT generation

**Document Version**: 1.0
**Last Updated**: 2025-01-17
**Status**: Design specification (not yet implemented)
