# Customer & Service Schema

## Overview

This document defines the high-level schema for managing customers and backend services in the Suiftly platform.

## Core Concepts

### Customer Identity

- **Customer = Wallet**: One wallet address = one customer (1:1 relationship)
- **No PII**: No personal information collected or required
- **Terms**: "Customer" and "wallet" are used interchangeably throughout the system

> **Note**: If a business entity controls multiple wallets, each wallet is treated as a distinct, independent customer.

### Customer Account Structure

```
Customer (Wallet Address)
├── Suiftly Account (Escrow Contract - On-chain)
│   ├── Deposit operations
│   ├── Withdraw operations
│   ├── Suiftly charge/credit operations
│   └── Balance tracking
└── Services (0 or more)
    ├── Seal Service
    ├── gRPC Service (future)
    └── GraphQL Service (future)
```

## On-Chain Account (Escrow Contract)

### Purpose
Sui-based escrow smart contract that manages customer funds for service usage.

### Capabilities
- **Customer operations**:
  - Deposit assets
  - Withdraw assets
  - Set maximum monthly spending authorization (in USD)
  - View balance and transaction history
- **Suiftly operations**:
  - Charge for service usage (up to authorized limit)
  - Credit refunds or adjustments
  - Automated billing integration

### Monthly Spending Authorization

**For complete escrow contract specification and authorization flows, see [ESCROW_DESIGN.md](ESCROW_DESIGN.md#on-chain-protections).**

**Key Concepts:**

Customers must explicitly authorize a maximum monthly spending cap (in USD equivalent) on-chain via the escrow smart contract. This provides:

- ✅ Trustless: Customer explicitly authorizes spending limits on-chain
- ✅ Customer control: Can update limit at any time via on-chain transaction
- ✅ Protects customers: Prevents unexpected charges
- ✅ Protects Suiftly: Clear authorization trail

Default limit: $2,000/month (adjustable from $100 to $50,000)

**Off-Chain Validation:**

Before allowing operations, Suiftly backend validates:

```typescript
// Pre-operation check
if (customerBalance < estimatedCost) {
  return { allowed: false, reason: "insufficient_balance" };
}

if (currentMonthCharged + estimatedCost > maxMonthlyUSD) {
  return { allowed: false, reason: "monthly_limit_exceeded" };
}

// Allow operation
return { allowed: true };
```

**Use Cases:**

1. **Service enablement**: Check before enabling a new service
2. **Tier upgrade**: Verify customer can afford higher tier
3. **Real-time operations**: HAProxy can query balance before proxying requests
4. **Billing operations**: Validate before charging escrow account

### On-Chain ↔ Off-Chain Synchronization

**Event Monitoring:**

The backend monitors on-chain escrow contract events:

```typescript
// Event types from escrow contract
enum EscrowEvent {
  Deposit,              // Customer deposited funds
  Withdraw,             // Customer withdrew funds
  SetMonthlyLimit,      // Customer updated spending authorization
  Charge,               // Suiftly charged for services (idempotent with nonce)
  Credit,               // Suiftly issued credit/refund
  MonthlyReset,         // Automatic monthly counter reset
}
```

**Synchronization Process:**

1. **Sui Event Listener**: Backend runs redundant event listeners for reliability
2. **Idempotent Processing**: Each event has unique ID, preventing duplicate processing
3. **Write-Through Cache**: On-chain is source of truth, cache for read performance
4. **Optimistic Locking**: Version numbers prevent concurrent update conflicts
5. **Circuit Breaker**: Falls back to on-chain reads if sync fails

**Cache Strategy:**

```typescript
interface CustomerCache {
  customer_id: number;
  balance_usd_cents: bigint;
  max_monthly_usd_cents: bigint;
  current_month_charged_usd_cents: bigint;
  last_month_charged_usd_cents: bigint;
  cache_version: number;              // Incremented on each update
  last_synced_at: Date;
  last_synced_tx_digest: string;
}

// Stale cache detection
async function getCustomerBalance(customerId: number): Promise<bigint> {
  const cache = await getCache(customerId);

  // Use cache for non-critical reads
  if (Date.now() - cache.last_synced_at < 5_000) {
    return cache.balance_usd_cents;
  }

  // Critical operations always check on-chain
  if (isCriticalOperation()) {
    return await getOnChainBalance(customerId);
  }

  // Background refresh for stale cache
  scheduleBackgroundRefresh(customerId);
  return cache.balance_usd_cents;
}
```

**Consistency Guarantees:**
- Strong consistency for charges (on-chain enforcement)
- Eventual consistency for display (5-second staleness acceptable)
- Idempotent operations prevent double-charging
- Monthly reset handled atomically on-chain

### Authentication
- On-chain operations: Authenticated via wallet signature (native Sui transaction signing)

## Off-Chain Operations & Authentication

### JWT-Based Authentication

For off-chain configuration and management operations, we use JWT tokens:

1. **Wallet Connection**: Customer connects wallet to web dashboard
2. **Challenge-Response**:
   - Backend generates a unique challenge message
   - Customer signs the challenge with their wallet
   - Backend verifies the signature and issues a JWT
3. **JWT Token**:
   - Contains wallet address as the primary identifier
   - Used for all subsequent off-chain API calls
   - Short-lived with refresh token capability
   - Enables configuration changes without blockchain transactions

### Off-Chain Operations
- Service configuration (tier selection, feature flags)
- API key management (create, revoke, rotate)
- Seal key management
- Usage analytics and billing history
- Service enablement/disablement
- Balance and spending limit validation

### Balance & Spending Limit Validation

**Real-Time Checks:**

Before allowing any operation that may incur charges, the backend validates:

1. **Sufficient Balance**: `current_balance >= estimated_cost`
2. **Within Monthly Limit**: `current_month_charged + estimated_cost <= max_monthly_usd`

**Declining Operations:**

Suiftly can decline off-chain operations if:
- Insufficient funds in escrow account
- Monthly spending limit would be exceeded
- Account is suspended or disabled

**Response Example:**

```typescript
// Operation declined - insufficient balance
{
  "success": false,
  "error": "insufficient_balance",
  "details": {
    "current_balance_usd": 5.42,
    "estimated_cost_usd": 10.00,
    "required_deposit_usd": 4.58
  }
}

// Operation declined - monthly limit exceeded
{
  "success": false,
  "error": "monthly_limit_exceeded",
  "details": {
    "max_monthly_usd": 100.00,
    "current_month_charged_usd": 95.50,
    "estimated_cost_usd": 10.00,
    "remaining_authorization_usd": 4.50
  }
}
```

**Operations Subject to Validation:**
- Enabling a new service
- Upgrading service tier
- Purchasing additional Seal keys
- Any configuration change that increases costs

## Service Model

### Service Constraints
- **One instance per service type**: A customer can run exactly one instance of each service
  - 1× Seal service (if enabled)
  - 1× gRPC service (if enabled, future)
  - 1× GraphQL service (if enabled, future)

### Service Tiers
Each service can be configured independently with different tiers:

| Tier | Description | Target |
|------|-------------|--------|
| **Starter** | Entry-level, lower limits | Individual developers, testing |
| **Pro** | Enhanced limits and features | Small teams, production apps |
| **Business** | Highest limits, priority support | Enterprise, high-volume apps |

**For complete tier definitions and rate limits, see [SEAL_SERVICE_CONFIG.md](SEAL_SERVICE_CONFIG.md).**

### Service Billing
- **Primary model**: Usage-based charging (e.g., requests count)
- **Tier structure**: See [SEAL_SERVICE_CONFIG.md](SEAL_SERVICE_CONFIG.md) for tier definitions and rate limits
- **Metering**: Real-time usage tracking against rate limits
- **Billing cycle**: Charges deducted from escrow account from time to time (usually when at least 5$ accumulated)
- **Monthly limits**: All charges validated against customer's authorized monthly spending cap

**Billing Flow:**

```typescript
// On each billing cycle (e.g., hourly or daily)
async function processBilling(customerUUID: string, serviceType: string) {
  // 1. Calculate usage charges
  const usage = await getUsageForPeriod(customerUUID, serviceType, period);
  const chargeAmountUSD = usage.requests * tierConfig.price_per_request;

  // 2. Validate against monthly limit (off-chain check)
  const customer = await getCustomer(customerUUID);
  if (customer.current_month_charged + chargeAmountUSD > customer.max_monthly_usd) {
    // Suspend service - monthly limit exceeded
    await suspendService(customerUUID, serviceType, "monthly_limit_exceeded");
    return { success: false, reason: "monthly_limit_exceeded" };
  }

  // 3. Validate balance (off-chain check)
  if (customer.current_balance_usd < chargeAmountUSD) {
    // Suspend service - insufficient balance
    await suspendService(customerUUID, serviceType, "insufficient_balance");
    return { success: false, reason: "insufficient_balance" };
  }

  // 4. Execute on-chain charge
  const txDigest = await chargeEscrowAccount(customer.wallet_address, chargeAmountUSD);

  // 5. Update off-chain records
  await updateCustomerSpending(customerUUID, chargeAmountUSD);
  await recordUsage(customerUUID, serviceType, usage, chargeAmountUSD);

  return { success: true, tx_digest: txDigest };
}
```

**Monthly Reset:**

On the first day of each calendar month:
1. **Save Previous Month**: Store `current_month_charged_usd` as `last_month_charged_usd` (both on-chain and off-chain)
2. **Reset Counter**: Reset `current_month_charged_usd` to 0 (on-chain contract)
3. **Sync Off-Chain**: Backend detects event and updates database:
   - `customers.last_month_charged_usd_cents` ← previous month's total
   - `customers.current_month_charged_usd_cents` ← 0
   - `customers.current_month_start` ← first day of new month
4. **Re-enable Services**: Suspended services (due to monthly limit) are automatically re-enabled if balance is sufficient

**Display to Customer:**

The dashboard shows:
- **Account Balance**: Current funds in escrow (on-chain state)
- **Pending Charges**: Unbilled usage since last billing cycle (off-chain calculation)
- **Current Month Charged**: Charges already billed this month (on-chain state)
- **Last Month Total**: Final charges from the previous completed month (on-chain state)
- **Monthly Spending Limit**: Authorized maximum spending per month (on-chain state)

```typescript
// Example dashboard data
{
  "account_balance_usd": 150.00,        // On-chain: actual funds available
  "pending_charges_usd": 3.42,          // Off-chain: unbilled usage (calculated in real-time)
  "current_month": "2025-02",
  "current_month_charged_usd": 42.75,   // On-chain: February charges already billed
  "last_month_total_usd": 87.23,        // On-chain: January 2025 total
  "max_monthly_usd": 100.00             // On-chain: safety limit
}
```

**Rationale:**
- **Account Balance** is the primary metric - customers need to know when to deposit funds
- **Pending Charges** provides early warning before billing executes (helps avoid service suspension)
- **Current Month Charged** uses parallel terminology with "Pending Charges" for clarity
- **Monthly Limit** is a safety mechanism, not a spending target
- Avoid "Available This Month" calculation - it adds confusion between balance and limit constraints

**Pending Charges Calculation:**

```typescript
// Optimized with materialized view and application-level caching
class PendingChargesCache {
  private cache = new Map<number, { value: number; timestamp: number }>();
  private TTL = 30_000; // 30 seconds

  async calculatePendingCharges(customerId: number): Promise<number> {
    // Check application-level cache first (30-second TTL)
    const cached = this.cache.get(customerId);
    if (cached && Date.now() - cached.timestamp < this.TTL) {
      return cached.value;
    }

    // Use materialized view for fast aggregation
    const result = await db.query(`
      SELECT SUM(pending_charge_usd_cents) as total
      FROM pending_charges_view
      WHERE customer_id = $1
    `, [customerId]);

    const totalCents = result.rows[0]?.total || 0;
    const totalUsd = totalCents / 100;

    // Update application cache
    this.cache.set(customerId, {
      value: totalUsd,
      timestamp: Date.now()
    });

    // Optional: Cleanup old entries periodically
    if (this.cache.size > 10000) {
      this.cleanupOldEntries();
    }

    return totalUsd;
  }

  private cleanupOldEntries() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.TTL) {
        this.cache.delete(key);
      }
    }
  }
}

// Background job updates materialized view every 30 seconds
CREATE MATERIALIZED VIEW pending_charges_view AS
SELECT
  customer_id,
  service_type,
  SUM(request_count * tier_price_per_request) as pending_charge_usd_cents
FROM usage_records
WHERE charged_amount IS NULL
  AND window_start >= DATE_TRUNC('hour', NOW() - INTERVAL '24 hours')
GROUP BY customer_id, service_type;

CREATE INDEX idx_pending_customer ON pending_charges_view(customer_id);
```

**Performance Optimizations:**
- Application-level cache reduces DB queries for frequently accessed data
- Materialized view pre-aggregates data (refreshed every 30s)
- Index on customer_id for O(log n) lookups
- Background refresh prevents blocking
- No external cache dependencies (simpler operations)

## API Key System

### Purpose
API keys authenticate service requests and map to customer accounts for billing and rate limiting.

### Requirements
1. **Customer Identification**: API key must quickly resolve to a customer account
2. **Multiple Keys per Service**: A customer can have multiple active API keys for the same service
3. **Interchangeable**: All API keys for a customer's service are functionally equivalent
4. **Revocable**: Keys can be revoked/rotated without affecting other keys
5. **Secure**: Knowledge of one API key must not enable derivation of other keys
6. **High Performance**: Lookup must be extremely fast (HAProxy-compatible)

### API Key Architecture

#### Key Generation

```
API Key Structure:
  <service><base32_payload><checksum>

Example:
  SABCDEFGHIJKLMNOPQRST234567

Components:
  - Service: Single uppercase character (S=Seal, R=gRPC, G=GraphQL)
  - Payload: Base32-encoded data (12 bytes → 20 chars, fixed length)
  - Checksum: HMAC-SHA256 signature (2 bytes → 4 chars Base32)

Service Type Identifiers:
  - S → Seal service
  - R → gRPC service (future)
  - G → GraphQL service (future)

Payload Structure (12 bytes):
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

**Key Generation Logic:**

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
  const checksum = base32Encode(signature); // 4 Base32 chars

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
  const checksum = apiKey.slice(21);           // Last 4 chars

  // Decode Base32 payload
  const payload = base32Decode(base32Payload);

  // Verify HMAC-SHA256 checksum
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(payload);
  const expectedSignature = hmac.digest().slice(0, 2);
  const providedChecksum = base32Decode(checksum);

  if (!expectedSignature.equals(providedChecksum)) {
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

**Why Base32?**
- Fast decode performance (~10-20ns vs Base58's ~200ns)
- Fixed length encoding (always 20 chars for 12 bytes)
- No ambiguous characters (uses A-Z, 2-7 only)
- Case-insensitive (easier to read/type)
- Standard encoding (RFC 4648) with excellent library support

**Encoding Efficiency:**
- Hex: 12 bytes → 24 characters (4 bits/char)
- Base32: 12 bytes → 20 characters (5 bits/char) ✓ **SELECTED**
- Base64: 12 bytes → 16 characters (but has +/= chars, ambiguous)
- Base58: 12 bytes → ~17 characters (but slow decode, variable length)

**Total API Key Length:**
```
SABCDEFGHIJKLMNOPQRST234567
└┬┘ └──────────┬──────────┘ └┬┘
 │             │              │
 1 char     20 chars      4 chars

Total: 25 characters (fixed length, fast decode)
```

**Format Benefits:**
- **10x faster decode** than Base58 (~20ns vs ~200ns)
- **Fixed length**: Always exactly 25 characters (no variation)
- No underscores/delimiters needed (service char distinct from Base32 alphabet)
- Single character service identifier
- All uppercase (consistent, professional appearance)

#### Customer Mapping System

**Customer ID Generation:**

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

**Why random IDs?**
- **Security**: Prevents attacker from enumerating all customer IDs
- **Privacy**: Hides customer count and growth rate
- **Attack prevention**: Even with decoded API keys, can't guess other customer IDs
- **Same size**: Still 4 bytes (no payload increase)

**Collision probability:**
- With 1M customers: ~0.023% chance of collision
- With 10M customers: ~2.3% chance of collision
- Retry loop handles collisions automatically
- Expected retries: < 1 per 1000 customer creations

**Database Schema:**

```sql
-- Customers table
CREATE TABLE customers (
  customer_id INTEGER PRIMARY KEY,         -- 32-bit random ID (1 to 4,294,967,295, excludes 0)
  wallet_address VARCHAR(66) NOT NULL UNIQUE, -- Sui wallet address (0x...)
  escrow_contract_id VARCHAR(66),          -- On-chain escrow object ID
  max_monthly_usd_cents BIGINT,            -- Maximum authorized monthly spending (USD cents)
  current_balance_usd_cents BIGINT,        -- Current balance in USD cents (cached from on-chain)
  current_month_charged_usd_cents BIGINT,  -- Amount charged this month (USD cents)
  last_month_charged_usd_cents BIGINT,     -- Amount charged last month (USD cents)
  current_month_start DATE,                -- Start date of current billing month
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,

  INDEX idx_wallet (wallet_address),
  CHECK (customer_id > 0)                  -- Ensure customer_id is never 0
);

-- API Keys table
CREATE TABLE api_keys (
  api_key_id VARCHAR(100) PRIMARY KEY,     -- The full API key string
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  service_type VARCHAR(20) NOT NULL,       -- 'seal', 'grpc', 'graphql'
  key_version SMALLINT NOT NULL,           -- Extracted from metadata byte (bits 7-6)
  is_imported BOOLEAN NOT NULL,            -- Extracted from metadata byte (bit 5)
  master_key_group SMALLINT NOT NULL,      -- Extracted from metadata byte (bits 4-0)
  derivation INTEGER,                      -- 3-byte index (0-16M), scope: per master_key_group
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP NULL,

  INDEX idx_customer_service (customer_id, service_type, is_active),
  INDEX idx_group_derivation (master_key_group, derivation)
);
```

#### Fast Lookup Mechanism for HAProxy

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

**HAProxy Integration Flow:**

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

  -- Extract checksum (last 4 chars)
  local checksum_b32 = api_key:sub(22, 25)

  -- Decode Base32 payload (~20ns)
  local payload = base32_decode(payload_b32)
  local checksum = base32_decode(checksum_b32)

  -- Verify HMAC-SHA256 signature (~200ns)
  local hmac = openssl.hmac.new(SECRET_KEY, "sha256")
  hmac:update(payload)
  local signature = hmac:final()
  local expected = signature:sub(1, 2)  -- First 2 bytes

  if checksum ~= expected then
    return nil, "invalid_signature"
  end

  -- Skip metadata byte (byte 0) and derivation (bytes 1-3)
  -- Extract customer ID (bytes 4-7)
  local customer_id = bytes_to_uint32(payload:sub(5, 8))

  -- Validate customer_id is not 0 (reserved value)
  if customer_id == 0 then
    return nil, "invalid_customer_id"
  end

  -- Optional: Check revocation in HAProxy shared memory
  -- local revoked = core.get_map("/etc/haproxy/revoked_keys.map")
  -- if revoked:lookup(api_key) then
  --   return nil, "revoked"
  -- end

  -- Return customer_id as string for sticky table
  return tostring(customer_id)
end
```

**Performance:**

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

**Revocation Checking (Optimized with Bloom Filter):**

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

#### Security Properties

1. **HMAC Authentication Prevents Forgery**:
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

**Secret Key Management:**
- SECRET_KEY must be securely stored (environment variable, secrets manager)
- Different keys for production/staging/development
- Rotate SECRET_KEY periodically (requires reissuing all API keys)
- Never commit SECRET_KEY to version control

### API Key Operations

**Create Key (Rate Limited):**
```typescript
POST /api/v1/services/{service_type}/keys
Authorization: Bearer <jwt_token>

// Rate limits:
// - Max 10 keys per service per customer
// - Max 5 key creations per hour per customer
// - Max derivation index: 1000 per customer (prevents exhaustion attacks)

Request:
{
  "is_imported": false,  // optional, default: false
  "master_key_group": 1  // optional, default: 1
}

Response:
{
  "api_key": "SABCDEFGHIJKLMNOPQRST234567",
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

**List Keys:**
```typescript
GET /api/v1/services/{service_type}/keys
Authorization: Bearer <jwt_token>

Response:
{
  "keys": [
    {
      "key_prefix": "SABCD...234567",
      "derivation": 0,
      "is_imported": false,
      "master_key_group": 1,
      "created_at": "2025-01-15T10:30:00Z",
      "is_active": true
    },
    {
      "key_prefix": "SEFGH...567234",
      "derivation": 1,
      "is_imported": false,
      "master_key_group": 1,
      "created_at": "2025-01-16T14:22:00Z",
      "is_active": true
    }
  ]
}
```

**Revoke Key:**
```typescript
DELETE /api/v1/services/{service_type}/keys/{derivation}
Authorization: Bearer <jwt_token>

Response:
{
  "success": true,
  "revoked_at": "2025-01-17T09:15:00Z"
}
```

## Seal Service Specifics

### Current Implementation Priority
The Seal service is the **first and only service** being implemented initially.

### Seal Keys vs API Keys

**Important Distinction:**

- **API Keys**: Authentication tokens for making requests to the Seal service
- **Seal Keys**: Sui cryptographic key pairs used by the Seal protocol itself

These are completely different concepts:

| Aspect | API Key | Seal Key |
|--------|---------|----------|
| **Purpose** | Authenticate customer requests | Sui signing keys for Seal protocol |
| **Managed By** | Suiftly platform | Customer (purchased from Suiftly) |
| **Quantity** | Multiple per customer | 1+ per customer (purchasable) |
| **Used In** | HTTP request headers | Seal transaction signing |
| **Revocable** | Yes, instantly | No (blockchain key pairs) |

### Seal Key Management

**Schema:**

```sql
CREATE TABLE seal_keys (
  seal_key_id UUID PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  public_key VARCHAR(66) NOT NULL,          -- Sui public key
  encrypted_private_key TEXT NOT NULL,      -- Encrypted with customer's wallet
  purchase_tx_digest VARCHAR(64),           -- On-chain purchase transaction
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL,

  INDEX idx_customer (customer_id)
);
```

**Purchase Flow:**

1. Customer initiates Seal key purchase through dashboard
2. Payment transaction on-chain (deducted from escrow)
3. Backend generates new Sui key pair
4. Private key encrypted with customer's wallet public key
5. Public key registered on-chain if required by Seal protocol
6. Customer can download encrypted private key

**Additional Seal Keys:**

- Customers can purchase additional Seal keys beyond the first
- Each additional key incurs a one-time fee
- All Seal keys for a customer have equal privileges
- Use cases: Key rotation, separate keys per environment, backup keys

### Seal Service Configuration

```sql
CREATE TABLE service_instances (
  instance_id UUID PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  service_type VARCHAR(20) NOT NULL,        -- 'seal'
  tier VARCHAR(20) NOT NULL,                -- 'basic', 'pro', 'business'
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  config JSONB,                             -- Service-specific configuration
  enabled_at TIMESTAMP,
  disabled_at TIMESTAMP,

  UNIQUE (customer_id, service_type)
);
```

**Seal Service Configuration:**

For tier-specific limits, pricing, and rate limiting details, see [SEAL_SERVICE_CONFIG.md](SEAL_SERVICE_CONFIG.md).

## Rate Limiting

### Per-Customer Enforcement

Rate limits are enforced **per customer**, not per API key.

**Rationale:**
- Prevents circumventing limits by creating multiple API keys
- Simplifies customer experience (aggregate view of usage)
- Aligns with billing (customer pays for total usage)

### HAProxy Sticky Table Implementation

```
# HAProxy configuration concept
stick-table type string len 32 size 100k expire 1h store http_req_rate(10s)

# On request:
1. Extract API key from Authorization header
2. Call Lua script to lookup customer_sticky_key
3. Track rate against customer_sticky_key in stick table
4. Deny if rate exceeds tier limit
```

**Flow:**

```
Request with API Key A (Customer 42, Seal Service)
  └─> Decode: customer_id = 42
  └─> Sticky key: "42"
  └─> Sticky table: "42" → 45 req/10s

Request with API Key B (Customer 42, Seal Service - different derivation)
  └─> Decode: customer_id = 42 (same)
  └─> Sticky key: "42" (same)
  └─> Sticky table: "42" → 46 req/10s (incremented)

Request with API Key C (Customer 99, Seal Service)
  └─> Decode: customer_id = 99
  └─> Sticky key: "99"
  └─> Sticky table: "99" → 12 req/10s (separate counter)
```

## Service-Specific API Keys

### Independence Across Services

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

**Customer Sticky Key Generation:**

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

**Benefits:**
- Service isolation (compromise of one doesn't affect others)
- Independent key rotation per service
- Service-specific rate limits and billing
- Clear audit trails per service

## Database Schema Summary

### Complete Schema

```sql
-- Customers (wallet = customer)
CREATE TABLE customers (
  customer_id INTEGER PRIMARY KEY,         -- 32-bit random ID (1 to 4,294,967,295, excludes 0)
  wallet_address VARCHAR(66) NOT NULL UNIQUE, -- Sui wallet address (0x...)
  escrow_contract_id VARCHAR(66),          -- On-chain escrow object ID
  max_monthly_usd_cents BIGINT,            -- Maximum authorized monthly spending (USD cents)
  current_balance_usd_cents BIGINT,        -- Current balance in USD cents (cached from on-chain)
  current_month_charged_usd_cents BIGINT,  -- Amount charged this month (USD cents)
  last_month_charged_usd_cents BIGINT,     -- Amount charged last month (USD cents) - for display
  current_month_start DATE,                -- Start date of current billing month
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,

  INDEX idx_wallet (wallet_address),
  CHECK (customer_id > 0)                  -- Ensure customer_id is never 0
);

-- Service instances
CREATE TABLE service_instances (
  instance_id UUID PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  service_type VARCHAR(20) NOT NULL,
  tier VARCHAR(20) NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  config JSONB,
  enabled_at TIMESTAMP,
  disabled_at TIMESTAMP,

  UNIQUE (customer_id, service_type)
);

-- API keys for service authentication
CREATE TABLE api_keys (
  api_key_id VARCHAR(100) PRIMARY KEY,     -- Full API key string
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  service_type VARCHAR(20) NOT NULL,       -- 'seal', 'grpc', 'graphql'
  key_version SMALLINT NOT NULL,           -- Extracted from metadata byte (bits 7-6)
  is_imported BOOLEAN NOT NULL,            -- Extracted from metadata byte (bit 5)
  master_key_group SMALLINT NOT NULL,      -- Extracted from metadata byte (bits 4-0)
  derivation INTEGER,                      -- 3-byte index (0-16M), scope: per master_key_group
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP NULL,

  INDEX idx_customer_service (customer_id, service_type, is_active),
  INDEX idx_group_derivation (master_key_group, derivation)
);

-- Seal keys (Seal service specific)
CREATE TABLE seal_keys (
  seal_key_id UUID PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  public_key VARCHAR(66) NOT NULL,
  encrypted_private_key TEXT NOT NULL,
  purchase_tx_digest VARCHAR(64),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL,

  INDEX idx_customer (customer_id)
);

-- Usage tracking for billing
CREATE TABLE usage_records (
  record_id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  service_type VARCHAR(20) NOT NULL,
  request_count BIGINT NOT NULL,
  bytes_transferred BIGINT,
  window_start TIMESTAMP NOT NULL,
  window_end TIMESTAMP NOT NULL,
  charged_amount DECIMAL(20, 8),

  INDEX idx_customer_time (customer_id, window_start),
  INDEX idx_billing (customer_id, service_type, window_start)
);

-- Escrow transactions (mirror of on-chain events)
CREATE TABLE escrow_transactions (
  tx_id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  tx_digest VARCHAR(64) NOT NULL UNIQUE,
  tx_type VARCHAR(20) NOT NULL,  -- 'deposit', 'withdraw', 'charge', 'credit'
  amount DECIMAL(20, 8) NOT NULL,
  asset_type VARCHAR(66),         -- Coin type
  timestamp TIMESTAMP NOT NULL,

  INDEX idx_customer (customer_id),
  INDEX idx_tx_digest (tx_digest)
);
```

## Implementation Notes

### Phase 1: Seal Service (Current)
- Implement customer + wallet authentication
- Build Seal service configuration
- Implement API key system with fast lookup
- Integrate HAProxy sticky tables with customer mapping
- Deploy Seal key purchase and management
- Set up usage metering and billing

### Phase 2: Additional Services (Future)
- gRPC service with independent API keys
- GraphQL service with independent API keys
- Reuse customer and billing infrastructure
- Extend service_instances and api_keys tables

### Security Considerations
- Never log full API keys (log only key_id or prefix)
- Encrypt Seal private keys with customer's wallet
- Rate limit authentication endpoints (prevent brute force)
- Implement API key rotation reminders
- Monitor for suspicious patterns (rapid key creation)

### Performance Targets
- API key lookup: <1ms (cached), <10ms (DB)
- HAProxy sticky table resolution: <1ms
- JWT validation: <5ms
- Database queries: Indexed for sub-10ms response times

---

**Document Version**: 1.10
**Last Updated**: 2025-01-16
**Status**: Design specification (not yet implemented)

**Changelog:**
- v1.10: Simplified caching architecture:
  - Replaced Redis with application-level caching for simpler operations
  - Application cache provides 30-second TTL for pending charges
  - Maintains same performance with reduced operational complexity
  - No external cache dependencies required
- v1.9: Major performance and security improvements:
  - Kept 4-byte reserved field in API key payload for future extensibility (25 chars total)
  - Added bloom filter for revocation checks (+5ns for 99.9% of requests)
  - Implemented rate limiting for API key generation (max 10 keys/service, 5/hour)
  - Added materialized view + application-level caching for pending charges
  - Improved cache consistency with idempotent operations and circuit breakers
  - Fixed all customer_uuid references to customer_id
  - Enhanced error handling for monthly reset race conditions
- v1.8: Changed customer_id from auto-increment to cryptographically random (1 to 4,294,967,295)
- v1.7: Added HMAC-SHA256 authentication, HAProxy Lua validation (~230ns total)
- v1.6: Changed encoding from Base58 to Base32 for 10x faster decode (~20ns)
- v1.5: Optimized API key format with single character service identifier
- v1.4: Reduced customer identifier from UUID to 32-bit integer
- v1.3: Enhanced API key design with embedded metadata
- v1.2: Changed terminology from "spent" to "charged"
- v1.1: Added monthly spending authorization
- v1.0: Initial schema design
