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

Default limit: $200/month (adjustable from $20 to "no limit")

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

For off-chain configuration and management operations, we use wallet-based authentication with JWT sessions.

**See [AUTHENTICATION_DESIGN.md](AUTHENTICATION_DESIGN.md) for complete authentication flow and implementation details.**

**Summary:**
- Challenge-response signature verification (proof of wallet ownership)
- Two-token system: 15-min access token + 30-day refresh token
- Automatic token refresh (transparent to user)
- Enables configuration changes without blockchain transactions for each API call

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
| **Enterprise** | Highest limits, priority support | Enterprise, high-volume apps |

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

API keys authenticate service requests and map to customer accounts for billing and rate limiting

**For complete API key design, implementation, and security details, see [API_KEY_DESIGN.md](API_KEY_DESIGN.md).**


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
- Each additional key incurs a monthly fee
- All Seal keys for a customer have equal privileges
- Use cases: Separate keys per environment (dev/staging/prod), organizational isolation, disaster recovery backup
- **Important:** Seal keys are NOT rotated - they must be preserved to decrypt existing data

### Seal Service Configuration

```sql
CREATE TABLE service_instances (
  instance_id UUID PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  service_type VARCHAR(20) NOT NULL,        -- 'seal'
  tier VARCHAR(20) NOT NULL,                -- 'starter', 'pro', 'enterprise'
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

Each service type has its own namespace for API keys (identified by first character: S=Seal, R=gRPC, G=GraphQL). This provides:
- Service isolation (compromise of one doesn't affect others)
- Independent key rotation per service
- Service-specific rate limits and billing
- Clear audit trails per service

See [API_KEY_DESIGN.md](API_KEY_DESIGN.md) for implementation details.

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

-- API keys for service authentication (see API_KEY_DESIGN.md for format and encryption details)
CREATE TABLE api_keys (
  api_key_id VARCHAR(100) PRIMARY KEY,     -- Full API key string (encrypted)
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
  INDEX idx_customer_key_idx (customer_id, key_idx),
  UNIQUE (customer_id, key_idx)
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

**Document Version**: 1.11
**Last Updated**: 2025-01-17
**Status**: Design specification (not yet implemented)

**Changelog:**
- v1.11: Refactored API key design to separate document:
  - Moved detailed API key implementation to API_KEY_DESIGN.md
  - Kept high-level overview and database schema in this document
  - Added cross-references for complete specification
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
