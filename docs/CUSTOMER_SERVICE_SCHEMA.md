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

**For complete escrow contract specification and authorization flows, see [ESCROW_DESIGN.md](./ESCROW_DESIGN.md#on-chain-protections).**

**Key Concepts:**

Customers must explicitly authorize a maximum monthly spending cap (in USD equivalent) on-chain via the escrow smart contract. This provides:

- ✅ Trustless: Customer explicitly authorizes spending limits on-chain
- ✅ Customer control: Can update limit at any time via on-chain transaction
- ✅ Protects customers: Prevents unexpected charges
- ✅ Protects Suiftly: Clear authorization trail

Default limit: **$250/28 days** (adjustable from **$10** to **unlimited**) - See [CONSTANTS.md](./CONSTANTS.md) for authoritative values

**Off-Chain Validation:**

Before allowing operations, Suiftly backend validates:

```typescript
// Pre-operation check
if (customerBalance < estimatedCost) {
  return { allowed: false, reason: "insufficient_balance" };
}

if (currentPeriodCharged + estimatedCost > spendingLimitUSD) {
  return { allowed: false, reason: "spending_limit_exceeded" };
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

**See [AUTHENTICATION_DESIGN.md](./AUTHENTICATION_DESIGN.md) for complete authentication flow and implementation details.**

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

### Schema Design: Single Table vs Separate Tables

**Decision**: Use a single `service_instances` table for all service types.

**Rationale**:
- **Efficient iteration**: The `idx_service_type_state` index enables fast service-type filtering without full table scans
- **Schema flexibility**: Adding new service types requires no migrations
- **Consistent patterns**: Same CRUD code handles all services
- **Cross-service queries**: Easy to retrieve all services for a customer
- **Minimal overhead**: ENUM storage (4 bytes) + indexed filtering is highly efficient

**Performance**: With proper indexing, querying 100K seal instances from 300K total rows has the same performance as a dedicated `seal_instances` table.

### Service Tiers
Each service can be configured independently with different tiers:

| Tier | Description |
|------|-------------|
| **Starter** | Entry-level, no burst, no allowlist |
| **Pro** | More guaranteed bandwidth, burst and allowlist supported. |
| **Enterprise** | Significantly more guaranteed bandwidth. |

**For complete tier definitions and rate limits, see [UI_DESIGN.md](./UI_DESIGN.md) (pricing and tier configuration).**

### Service Billing
- **Primary model**: Usage-based charging (e.g., requests count)
- **Tier structure**: See [UI_DESIGN.md](./UI_DESIGN.md) (pricing and tier configuration) for tier definitions and rate limits
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
- **Last Month Total**: Final charges from the previous completed month (calculated from on-chain transaction history)
- **Monthly Spending Limit**: Authorized maximum spending per month (on-chain state)

```typescript
// Example dashboard data
{
  "account_balance_usd": 150.00,        // On-chain: actual funds available
  "pending_charges_usd": 3.42,          // Off-chain: unbilled usage (calculated in real-time)
  "current_month": "2025-02",
  "last_month_total_usd": 87.23,        // Calculated from on-chain transaction history: January 2025 total
  "max_monthly_usd": 100.00             // On-chain: safety limit
}
```

**Rationale:**
- **Account Balance** is the primary metric - customers need to know when to deposit funds
- **Pending Charges** provides early warning before billing executes (helps avoid service suspension)
- **Last Month Total** provides historical context for budgeting
- **Monthly Limit** is a safety mechanism, not a spending target
- Avoid showing "Current Month Charged" - potentially confusing when combined with pending charges
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

**For complete API key design, implementation, and security details, see [API_KEY_DESIGN.md](./API_KEY_DESIGN.md).**

### API Key Fingerprint Storage

The `api_key_fp` field stores 32-bit unsigned fingerprints in PostgreSQL's signed INTEGER type:

**Unsigned to Signed Conversion:**
```javascript
// JavaScript: 32-bit unsigned → signed (for PostgreSQL storage)
function toSigned32(unsigned) {
  return unsigned > 0x7FFFFFFF ? unsigned - 0x100000000 : unsigned;
}

// Example:
// Unsigned: 3,000,000,000 (0xB2D05E00)
// Signed:  -1,294,967,296 (stored in PostgreSQL)
```

**Signed to Unsigned Conversion:**
```javascript
// PostgreSQL → JavaScript: signed → 32-bit unsigned
function toUnsigned32(signed) {
  return signed < 0 ? signed + 0x100000000 : signed;
}

// Example:
// Signed:  -1,294,967,296 (from PostgreSQL)
// Unsigned: 3,000,000,000 (0xB2D05E00)
```

**In Practice:**
- Fingerprints are generated from first 7 Base32 characters of API key
- Values >= 2^31 (2,147,483,648) are stored as negative numbers in PostgreSQL
- Application code handles conversion transparently
- Collision retry generates new API key (with different fingerprint) on conflict


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
| **Managed By** | Suiftly platform | Customer (derived or imported) |
| **Quantity** | 0+ per customer (1 created by default) | 0+ per customer (NOT created by default) |
| **Used In** | HTTP request headers | Seal transaction signing |
| **Revocable** | Yes, instantly | No (blockchain key pairs) |
| **Default Creation** | Yes (1 API key on service creation) | No (user must derive or import) |

### Seal Key Management

**Schema:** See `seal_keys` table in [Database Schema Summary](#database-schema-summary) below.

**Creation Flow (Derive or Import):**

**Option 1: Derive New Seal Key**
1. Customer initiates Seal key derivation through dashboard
2. Backend generates new Sui key pair (derived from customer's wallet)
3. Private key encrypted with customer's wallet public key
4. Public key registered on-chain if required by Seal protocol
5. Customer can download encrypted private key

**Option 2: Import Existing Seal Key**
1. Customer provides existing Sui key pair
2. Backend validates and stores encrypted private key
3. Public key registered on-chain if required by Seal protocol

**Additional Seal Keys:**

- Customers can create additional Seal keys (derived or imported)
- Each Seal key incurs a monthly fee (no free tier)
- All Seal keys for a customer have equal privileges
- Use cases: Separate keys per environment (dev/staging/prod), organizational isolation, disaster recovery backup
- **Important:** Seal keys are NOT rotated - they must be preserved to decrypt existing data

### Seal Service Configuration

**Schema:** See `service_instances` table in [Database Schema Summary](#database-schema-summary) below.

**Seal Service Configuration:**

For tier-specific limits, pricing, and rate limiting details, see [UI_DESIGN.md](./UI_DESIGN.md) (pricing and tier configuration).

## Rate Limiting

### Per-Customer Enforcement

Rate limits are enforced **per customer**, not per API key.

**Rationale:**
- Prevents circumventing limits by creating multiple API keys
- Simplifies customer experience (aggregate view of usage)
- Aligns with billing (customer pays for total usage)

**Implementation:** HAProxy enforces rate limits using map files. See `~/walrus/docs` for HAProxy configuration details.

## Service-Specific API Keys

Each service type has its own namespace for API keys (identified by first character: S=Seal, R=gRPC, G=GraphQL). This provides:
- Service isolation (compromise of one doesn't affect others)
- Independent key rotation per service
- Service-specific rate limits and billing
- Clear audit trails per service

See [API_KEY_DESIGN.md](./API_KEY_DESIGN.md) for implementation details.

## Database Schema Summary

**NOTE**: The schema uses PostgreSQL ENUM types for type safety. See [ENUM_IMPLEMENTATION.md](./ENUM_IMPLEMENTATION.md) for details.

### Complete Schema

```sql
-- ENUM types (single source of truth - see ENUM_IMPLEMENTATION.md)
CREATE TYPE customer_status AS ENUM('active', 'suspended', 'closed');
CREATE TYPE service_type AS ENUM('seal', 'grpc', 'graphql');
CREATE TYPE service_state AS ENUM('not_provisioned', 'provisioning', 'disabled', 'enabled', 'suspended_maintenance', 'suspended_no_payment');
CREATE TYPE service_tier AS ENUM('starter', 'pro', 'enterprise');
CREATE TYPE transaction_type AS ENUM('deposit', 'withdraw', 'charge', 'credit');
CREATE TYPE billing_status AS ENUM('pending', 'paid', 'failed');

-- Customers (wallet = customer)
CREATE TABLE customers (
  customer_id INTEGER PRIMARY KEY,         -- 32-bit random ID (full signed range: -2,147,483,648 to 2,147,483,647, excludes 0)
  wallet_address VARCHAR(66) NOT NULL UNIQUE, -- Sui wallet address (0x...)
  escrow_contract_id VARCHAR(66),          -- On-chain escrow object ID
  status customer_status NOT NULL DEFAULT 'active', -- ENUM provides type safety
  max_monthly_usd_cents BIGINT,            -- Maximum authorized monthly spending (USD cents, NULL = unlimited)
  current_balance_usd_cents BIGINT,        -- Current balance in USD cents (cached from on-chain)
  current_month_charged_usd_cents BIGINT,  -- Amount charged this calendar month (USD cents)
  last_month_charged_usd_cents BIGINT,     -- Amount charged last calendar month (USD cents) - for display
  current_month_start DATE,                -- Start date of current billing month (1st of month)
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,

  INDEX idx_wallet (wallet_address),
  INDEX idx_customer_status (status) WHERE status != 'active',  -- Partial index for non-active customers
  CHECK (customer_id != 0)                 -- Ensure customer_id is never 0 (allows full 32-bit signed range)
);

-- Service instances
CREATE TABLE service_instances (
  instance_id SERIAL PRIMARY KEY,              -- Auto-increment (purely internal, never exposed)
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  service_type service_type NOT NULL,          -- ENUM
  state service_state NOT NULL DEFAULT 'not_provisioned', -- ENUM
  tier service_tier NOT NULL,                  -- ENUM
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  subscription_charge_pending BOOLEAN NOT NULL DEFAULT true,
  config JSONB,
  enabled_at TIMESTAMP,
  disabled_at TIMESTAMP,

  UNIQUE (customer_id, service_type),
  INDEX idx_service_type_state (service_type, state)  -- Efficient service-type iteration for backend sync
);

-- API keys for service authentication (see API_KEY_DESIGN.md for format and encryption details)
CREATE TABLE api_keys (
  api_key_fp INTEGER PRIMARY KEY,          -- 32-bit fingerprint (signed, stores unsigned values)
                                           -- First 7 Base32 chars of key → 32-bit integer
                                           -- Values >= 2^31 stored as negative (two's complement)
  api_key_id VARCHAR(100) UNIQUE NOT NULL, -- Full API key string (encrypted)
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  service_type service_type NOT NULL,      -- ENUM: 'seal', 'grpc', 'graphql'
  metadata JSONB NOT NULL DEFAULT '{}',    -- Service-specific fields (flexible for multi-service)
                                           -- Seal: {key_version, seal_network, seal_access, seal_source, proc_group}
                                           -- gRPC: TBD
                                           -- GraphQL: TBD
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP NULL,
  deleted_at TIMESTAMP NULL,               -- Soft delete timestamp

  INDEX idx_customer_service (customer_id, service_type, is_active)
  -- Note: No index on api_key_fp needed - PRIMARY KEY automatically indexed
);

-- Seal keys (Seal service specific)
CREATE TABLE seal_keys (
  seal_key_id UUID PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  instance_id INTEGER REFERENCES service_instances(instance_id) ON DELETE CASCADE,
  public_key VARCHAR(66) NOT NULL,
  encrypted_private_key TEXT NOT NULL,
  purchase_tx_digest VARCHAR(64),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL,

  INDEX idx_seal_customer (customer_id),
  INDEX idx_seal_instance (instance_id)
);

-- Seal packages (Seal service specific - package addresses associated with Seal keys)
CREATE TABLE seal_packages (
  package_id UUID PRIMARY KEY,
  seal_key_id UUID NOT NULL REFERENCES seal_keys(seal_key_id) ON DELETE CASCADE,
  package_address VARCHAR(66) NOT NULL,   -- Sui package address
  name VARCHAR(100),                       -- Optional friendly name
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL,

  INDEX idx_package_seal_key (seal_key_id)
);

-- Usage tracking for billing
CREATE TABLE usage_records (
  record_id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  service_type service_type NOT NULL,  -- ENUM
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
  tx_type transaction_type NOT NULL,  -- ENUM: 'deposit', 'withdraw', 'charge', 'credit'
  amount DECIMAL(20, 8) NOT NULL,
  asset_type VARCHAR(66),         -- Coin type
  timestamp TIMESTAMP NOT NULL,

  INDEX idx_escrow_customer (customer_id),
  INDEX idx_escrow_tx_digest (tx_digest)
);

-- HAProxy raw logs (TimescaleDB hypertable for usage metering and ops monitoring)
-- Based on walrus HAPROXY_LOGS.md specification
-- Ref: ~/walrus/docs/HAPROXY_LOGS.md and haproxy_log_record.py
CREATE TABLE haproxy_raw_logs (
  -- Timestamp (TimescaleDB partition key)
  timestamp TIMESTAMPTZ NOT NULL,

  -- Customer context (NULL if unauthenticated)
  customer_id INTEGER,                  -- NULL for auth failures, malformed requests
  path_prefix TEXT,                     -- First 10 chars of URL path without leading "/" (traffic analysis), NULL if missing
  config_hex BIGINT,                    -- Customer config (64-bit), NULL if denied before lookup

  -- Infrastructure context (decoded from merge_fields_1, all NOT NULL since merge_fields_1 always present)
  network SMALLINT NOT NULL,            -- Network (0=testnet, 1=mainnet, 2=devnet, 3=localnet)
  server_id SMALLINT NOT NULL,          -- Encoded: (region_id << 4) | server_num (8-bit)
  service_type SMALLINT NOT NULL,       -- Service (1=Seal, 2=SSFN, 3=Sealo)
  api_key_fp INTEGER NOT NULL,          -- API key fingerprint (32-bit), 0 if missing
  fe_type SMALLINT NOT NULL,            -- Frontend type (1=private, 2=metered, 3=local)
  traffic_type SMALLINT NOT NULL,       -- Traffic class (0=N/A, 1=guaranteed, 2=burst, 3=denied, 4=dropped, 5=ip_dropped, 6=unavailable)
  event_type SMALLINT NOT NULL,         -- Event type (0=success, 10-16=auth, 20-21=IP, 30=authz, 50-63=backend)
  client_ip INET NOT NULL,              -- Real client IP from CF-Connecting-IP (fallback to src)

  -- API key context (decoded from merge_fields_2, NULL if no valid API key)
  key_metadata SMALLINT,                -- 16-bit key metadata from API key

  -- Response (always present)
  status_code SMALLINT NOT NULL,        -- HTTP status code
  bytes_sent BIGINT NOT NULL DEFAULT 0, -- Response body size

  -- Timing (always available from HAProxy)
  time_total INT NOT NULL,              -- Total time (ms) - always available
  time_request INT,                     -- Time to receive request (ms), NULL if error before completion
  time_queue INT,                       -- Time in queue (ms), NULL if no queue wait
  time_connect INT,                     -- Backend connect time (ms), NULL if no backend connection
  time_response INT,                    -- Backend response time (ms), NULL if no backend response

  -- Backend routing
  backend_id SMALLINT DEFAULT 0,        -- Backend server (0=none, 1-9=local, 10-19=backup)
  termination_state TEXT,               -- HAProxy termination code (e.g., 'SD', 'SH', 'PR')

  -- Indexes (partial where useful to exclude common values)
  INDEX idx_logs_customer_time (customer_id, timestamp DESC) WHERE customer_id IS NOT NULL,
  INDEX idx_logs_server_time (server_id, timestamp DESC),
  INDEX idx_logs_service_network (service_type, network, timestamp DESC),
  INDEX idx_logs_traffic_type (traffic_type, timestamp DESC),
  INDEX idx_logs_event_type (event_type, timestamp DESC) WHERE event_type != 0,  -- Exclude successful requests
  INDEX idx_logs_status_code (status_code, timestamp DESC),
  INDEX idx_logs_api_key_fp (api_key_fp, timestamp DESC) WHERE api_key_fp != 0   -- Exclude requests without API key
);

-- NOTE: Implementation currently uses TEXT for client_ip, but INET is recommended for efficiency and validation

-- TimescaleDB hypertable configuration (applied via migration)
-- SELECT create_hypertable('haproxy_raw_logs', 'timestamp', chunk_time_interval => INTERVAL '1 hour');
-- SELECT add_compression_policy('haproxy_raw_logs', INTERVAL '6 hours');
-- SELECT add_retention_policy('haproxy_raw_logs', INTERVAL '2 days');  -- Aggressive: aggregates preserve historical data

-- Note: Continuous aggregates (metering_by_second, ops_by_minute) are defined separately
-- for efficient querying of historical data after raw logs are pruned.

-- Auth nonces (wallet signature anti-replay protection)
CREATE TABLE auth_nonces (
  address VARCHAR(66) PRIMARY KEY,         -- Wallet address
  nonce VARCHAR(64) NOT NULL,              -- Random challenge string
  created_at TIMESTAMP NOT NULL,           -- For 5-minute TTL expiry

  INDEX idx_created_at (created_at)        -- Cleanup expired nonces
);

-- Refresh tokens (JWT session revocation)
CREATE TABLE refresh_tokens (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  token_hash VARCHAR(64) NOT NULL UNIQUE,  -- SHA256 hash of refresh token
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL,

  INDEX idx_refresh_customer (customer_id),
  INDEX idx_expires_at (expires_at)        -- Cleanup expired tokens
);

-- Ledger entries (financial accounting with SUI/USD exchange rates)
CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  type transaction_type NOT NULL,          -- ENUM: 'deposit', 'withdraw', 'charge', 'credit'
  amount_usd_cents BIGINT NOT NULL,        -- USD amount (signed: + for deposit/credit, - for charge/withdrawal)
  amount_sui_mist BIGINT,                  -- SUI amount in mist (1 SUI = 10^9 mist), NULL for charges/credits
  sui_usd_rate_cents BIGINT,               -- Rate at transaction time (cents per 1 SUI), e.g., 245 = $2.45
  tx_hash VARCHAR(66),                     -- On-chain TX hash for deposits/withdrawals, NULL for charges/credits
  description TEXT,                        -- Human-readable description
  invoice_id VARCHAR(50),                  -- Optional invoice reference
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  INDEX idx_customer_created (customer_id, created_at DESC),
  INDEX idx_ledger_tx_hash (tx_hash) WHERE tx_hash IS NOT NULL
);

-- Billing records (charges and credits applied to accounts)
CREATE TABLE billing_records (
  id UUID PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  billing_period_start TIMESTAMP NOT NULL,
  billing_period_end TIMESTAMP NOT NULL,
  amount_usd_cents BIGINT NOT NULL,        -- Charged amount (positive) or credit (negative)
  type transaction_type NOT NULL,          -- ENUM: 'deposit', 'withdraw', 'charge', 'credit'
  status billing_status NOT NULL,          -- ENUM: 'pending', 'paid', 'failed'
  tx_digest VARCHAR(64),                   -- Escrow charge transaction (NULL if pending)
  created_at TIMESTAMP NOT NULL,

  INDEX idx_customer_period (customer_id, billing_period_start),
  INDEX idx_billing_status (status) WHERE status != 'paid'
);

-- Processing state (Global Manager resumability)
CREATE TABLE processing_state (
  key TEXT PRIMARY KEY,                    -- e.g., 'last_log_timestamp', 'last_billing_run'
  value TEXT NOT NULL,                     -- Timestamp or other state value
  updated_at TIMESTAMP NOT NULL
);

-- Global configuration (key-value store for ALL system settings)
-- Includes: tier pricing, bandwidth limits, feature flags, system parameters
-- Tier configuration keys:
--   - fsubs_usd_sta, fsubs_usd_pro, fsubs_usd_ent (monthly subscription price in USD)
--   - fbw_sta, fbw_pro, fbw_ent (bandwidth in req/sec per region)
--   - freg_count (number of regions)
-- Loaded into memory at server startup for O(1) lookups (see apps/api/src/lib/config-cache.ts)
CREATE TABLE config_global (
  key TEXT PRIMARY KEY,                    -- Configuration key
  value TEXT NOT NULL,                     -- Configuration value (stored as string)
  updated_at TIMESTAMP NOT NULL
);

-- User activity logs (audit trail for customer actions)
CREATE TABLE user_activity_logs (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  timestamp TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  client_ip INET NOT NULL,                 -- Client IP address
  message TEXT NOT NULL,                   -- Activity description

  INDEX idx_activity_customer_time (customer_id, timestamp DESC)
);

-- System control (singleton table for system-wide state)
CREATE TABLE system_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),   -- Singleton: only 1 row allowed
  ma_vault_version VARCHAR(64),            -- Expected MA_VAULT version deployed to infrastructure
  mm_vault_version VARCHAR(64),            -- Expected MM_VAULT version (if used)
  last_monthly_reset DATE,                 -- Last calendar month reset date
  maintenance_mode BOOLEAN DEFAULT false,  -- Pause new signups during maintenance
  updated_at TIMESTAMP NOT NULL
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
