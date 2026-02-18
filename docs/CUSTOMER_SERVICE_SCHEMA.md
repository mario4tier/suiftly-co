# Customer & Service Schema

## Overview

This document defines the high-level schema for managing customers and backend services in the Suiftly platform.

**Related:** [BILLING_DESIGN.md](./BILLING_DESIGN.md), [PAYMENT_DESIGN.md](./PAYMENT_DESIGN.md), [ESCROW_DESIGN.md](./ESCROW_DESIGN.md)

## Core Concepts

### Customer Identity

- **Customer = Wallet**: One wallet address = one customer (1:1 relationship)
- **No PII**: No personal information collected or required
- **Terminology**: "Customer" and "wallet" are used interchangeably throughout the system

> **Note**: If a business entity controls multiple wallets, each wallet is treated as a distinct, independent customer.

### Customer Account Structure

```
customers (wallet_address)
├── customer_payment_methods (user-defined priority order)
│   ├── Crypto (escrow) → customers.escrow_contract_id (on-chain)
│   ├── Stripe (card) → customers.stripe_customer_id
│   └── PayPal → provider_ref (billing agreement ID)
│
├── escrow_transactions (on-chain charge/credit records)
│
├── ledger_entries (all financial movements: charges, credits, deposits)
│
├── customer_credits (non-withdrawable, applied first in payment order)
│
├── billing_records (invoices: draft/pending/paid/failed/voided)
│   ├── invoice_line_items (itemized charges per invoice)
│   └── invoice_payments (multi-source payment tracking per invoice)
│
├── service_instances (0 or more)
│   ├── Seal: service_type='seal'
│   │   ├── seal_keys (derived or imported)
│   │   │   └── seal_packages (package addresses per key)
│   │   └── api_keys (service_type='seal')
│   │
│   ├── gRPC: service_type='grpc' (future)
│   │   └── api_keys (service_type='grpc')
│   │
│   └── GraphQL: service_type='graphql' (future)
│       └── api_keys (service_type='graphql')
│
├── usage_records (billing and metering)
│
└── haproxy_raw_logs (request logs, independent of usage_records)
```

See [BILLING_DESIGN.md](./BILLING_DESIGN.md) for invoice lifecycle and [PAYMENT_DESIGN.md](./PAYMENT_DESIGN.md) for payment provider abstraction.

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
  last_synced_tx_digest: Buffer;      // BYTEA (32 bytes)
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

**Escrow-Specific Checks (on-chain account):**

Before allowing escrow charges, the backend validates:

1. **Sufficient Balance**: `current_balance >= estimated_cost`
2. **Within Spending Limit**: `current_period_charged + estimated_cost <= spending_limit_usd`

**Service Gate (multi-provider):**

With multi-provider payments, service enabling requires:
1. At least one active payment method in `customer_payment_methods`
2. Any pending subscription invoice (`sub_pending_invoice_id`) resolved

A user with $0 escrow but a valid Stripe card passes the gate — actual payment validation happens at charge time via the provider chain. See [PAYMENT_DESIGN.md](./PAYMENT_DESIGN.md) for details.

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

**Key Principles:**
- **Primary model**: Subscription + usage-based charging
- **Tier structure**: See [UI_DESIGN.md](./UI_DESIGN.md) for tier definitions and rate limits
- **Metering**: Real-time usage tracking against rate limits → `usage_records`
- **Invoice lifecycle**: DRAFT → PENDING → PAID/FAILED/VOIDED (see [BILLING_DESIGN.md](./BILLING_DESIGN.md))
- **Payment processing**: Credits first, then provider chain in user-defined priority order (see [PAYMENT_DESIGN.md](./PAYMENT_DESIGN.md))

**Key tables:**
- `usage_records` — metering (what was used)
- `billing_records` — invoices (DRAFT projections, PENDING charges, PAID/FAILED outcomes)
- `invoice_line_items` — itemized charges per invoice
- `invoice_payments` — multi-source payment tracking (which provider paid what)
- `escrow_transactions` — on-chain charge/credit records

**Billing flow:**
1. `usage_records` aggregated → line items added to DRAFT invoice
2. DRAFT → PENDING on 1st of month (or immediately for mid-cycle charges)
3. `processInvoicePayment()` applies credits first, then tries providers in user's priority order
4. On success → invoice marked PAID, `invoice_payments` records created per source

See [BILLING_DESIGN.md](./BILLING_DESIGN.md) for concurrency control, tier change logic, and periodic job details.
See [PAYMENT_DESIGN.md](./PAYMENT_DESIGN.md) for `IPaymentProvider` interface and charge flow.

## API Key System

API keys authenticate service requests and map to customer accounts for billing and rate limiting

**For complete API key design, implementation, and security details, see [API_KEY_DESIGN.md](./API_KEY_DESIGN.md).**

### API Key Fingerprint Storage

The `api_key_fp` column is a 64-bit BIGINT primary key (matches `haproxy_raw_logs.api_key_fp`). Fingerprints are derived from the first 7 Base32 characters of the API key (35 bits), well within BIGINT range — no signed/unsigned conversion needed. Collision retry generates a new API key on conflict.


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

**Schema:** See `seal_keys` table in `packages/database/src/schema/seal.ts`.

**Seal Key Cryptography (BLS12-381 IBE):**

Seal uses Boneh-Franklin Identity-Based Encryption (IBE) with the BLS12-381 curve:
- **Master Secret Key (msk)**: 32 bytes (BLS12-381 scalar in field Fr)
- **Master Public Key (mpk)**: 48 bytes (G1 point, compressed) - this is what `public_key` field stores
- **Purpose**:
  - `mpk` (public_key) is **registered on-chain** and used by clients to encrypt data
  - `msk` (private key) is held by key server to derive identity-based decryption keys
- **On-chain Registration**: `sui client call --function create_and_transfer_v1 ... --args <PUBKEY>` registers the public key and returns `object_id`

**Two Key Types: Derived vs Imported**

Schema uses **nullable `derivation_index`** to distinguish key types (no explicit `key_type` field):

| Aspect | Derived Keys | Imported Keys |
|--------|--------------|---------------|
| **Identifier** | `derivation_index IS NOT NULL` | `derivation_index IS NULL` |
| **Generation** | Derived from `MASTER_SEED` + index | External BLS12-381 key imported |
| **Storage** | `derivation_index` only (~4 bytes) | `encrypted_private_key` (~hundreds of bytes) |
| **Regeneration** | ✅ Can regenerate from seed + index | ❌ Cannot regenerate (one-time import) |
| **Backup** | Seed backup sufficient | Full encrypted key backup required |
| **Use Case** | Primary production keys (recommended) | Migration from external systems, disaster recovery |

**Creation Flow (Derive or Import):**

**Option 1: Derive New Seal Key (Recommended)**

**SECURITY: The API server stores only the `derivation_index`. Keyservers derive private keys at runtime from `MASTER_SEED` (loaded from `~/.suiftly.env`). The API server NEVER has access to master seeds.**

1. **Key Creation** (API Server — `apps/api/src/routes/seal.ts`):
   - Customer initiates Seal key request through dashboard
   - API validates: authentication, service subscription, payment, key limits
   - **Atomically allocates derivation index** via `UPDATE system_control SET next_seal_derivation_index_pg{N} = next_seal_derivation_index_pg{N} + 1 RETURNING` (per process group)
   - Generates BLS12-381 key pair (mock in dev, `seal-cli` in production)
   - Inserts `seal_keys` record with `registration_status = 'registering'`
   - Queues `seal_registration_ops` entry (`opType: 'register'`, `status: 'queued'`)
   - Returns immediately with `public_key` — key is usable for encryption before on-chain registration completes

2. **On-Chain Registration** (Global Manager — `services/global-manager/src/tasks/process-seal-registrations.ts`):
   - GM polls `seal_registration_ops` for queued ops ready to process
   - Creates KeyServer object on Sui: `create_and_transfer_v1(name, url, key_type, pk)`
   - On success: sets `registration_status = 'registered'`, stores `object_id` and `register_txn_digest`
   - On failure: exponential backoff (0s, 5s, 15s, 45s, 2m15s, 5m max) — retries until success
   - Self-healing: stale ops stuck in 'processing' for >10 min are recovered to 'queued'
   - Idempotent: checks for existing KeyServer by `object_id` or `public_key` before creating

3. **Package Changes During Registration:**
   - Each package add/update/delete/toggle increments `seal_keys.packagesVersion`
   - If key is already `registered`, an `update` op is queued with the current `packagesVersionAtOp`
   - If key is still `registering`/`updating`, no extra op is queued — the post-registration check handles it
   - After successful registration, GM checks if `packagesVersion > registeredPackagesVersion`
   - If yes: marks key as `updating` and queues a new `update` op — **guarantees eventual consistency**

**Per-PG Derivation Index Counters:**
- `derivation_index` is **global across all customers**, scoped per process group (PG 1 = production, PG 2 = development)
- Counters stored in `system_control.next_seal_derivation_index_pg1` and `pg2`
- Atomic `UPDATE...RETURNING` prevents race conditions
- Each derived key gets a unique sequential index: 0, 1, 2, 3...
- Indices are NEVER reused (even if key is soft-deleted)
- Transaction-safe: index allocation is part of the key creation transaction

**Option 2: Import Existing Seal Key** (Future)
1. Customer provides existing BLS12-381 private key (32 bytes, hex-encoded) and Sui `object_id`
2. Backend validates key format and extracts public key (48 bytes)
3. Verify `object_id` exists on-chain and matches provided public key
4. **Customer transfers ownership** of the seal key object to Suiftly's `objects_owner_id` address
   - Required for Suiftly to update the key server URL associated with the object
   - Customer initiates transfer via Sui wallet: `sui client transfer --object-id <OBJECT_ID> --to <OBJECTS_OWNER_ID>`
5. Backend validates transfer completed successfully (object now owned by Suiftly)
6. Encrypt private key with database encryption key (for operational recovery)
7. Store: `encrypted_private_key`, `public_key` (48 bytes mpk), `object_id`, `register_txn_digest`
8. **derivation_index is NULL** - indicates imported key that cannot be regenerated
9. Update on-chain object with Suiftly's key server URL (now possible since Suiftly owns object)

**Key Ownership:**
- All registered Seal keys are owned by a Sui address controlled by Suiftly
- Owner's private key stored in mm vault: `objects_owner_sk`

**Related mm vault keys:**
- `master_key`: Seed used for BLS12-381 key derivation (MASTER_SEED per PG)
- `objects_owner_id`: Sui address owning all seal key objects
- `objects_owner_sk`: Private key for the owner address (used for on-chain registration)

**Seal Key States**

Registration status (`registration_status` pgEnum):
- `registering`: Initial on-chain registration in progress (KeyServer object being created)
- `registered`: Successfully registered on-chain (`object_id` is set)
- `updating`: Re-registration in progress (packages changed while registered)

No 'failed' state — unlimited auto-retry with exponential backoff ensures eventual registration.

Independent controls:
- `is_user_enabled`: User toggle for key serving (independent of registration status)
- `deletedAt`: Soft delete timestamp (blocked in production — derivation indices are non-renewable)

**Additional Seal Keys:**

- Customers can create additional Seal keys (derived or imported)
- Each Seal key incurs a monthly fee (no free tier)
- All Seal keys for a customer have equal privileges
- Use cases: Separate keys per environment (dev/staging/prod), organizational isolation, disaster recovery backup
- **Important:** Seal keys are NOT rotated - they must be preserved to decrypt existing encrypted data
- **Storage Efficiency**: Derived keys use ~4 bytes (`derivation_index`), imported keys use ~hundreds of bytes (encrypted key material)

### Seal Service Configuration

**Schema:** See `service_instances` table in `packages/database/src/schema/services.ts`.

**Seal Service Configuration:**

For tier-specific limits, pricing, and rate limiting details, see [UI_DESIGN.md](./UI_DESIGN.md) (pricing and tier configuration).

## Rate Limiting

### Per-Customer Enforcement

Rate limits are enforced **per customer**, not per API key.

**Rationale:**
- Prevents circumventing limits by creating multiple API keys
- Simplifies customer experience (aggregate view of usage)
- Aligns with billing (customer pays for total usage)

**Implementation:** HAProxy enforces rate limits using map files. See `~/mhaxbe/docs` for HAProxy configuration details.

## Service-Specific API Keys

Each service type has its own namespace for API keys (identified by first character: S=Seal, R=gRPC, G=GraphQL). This provides:
- Service isolation (compromise of one doesn't affect others)
- Independent key rotation per service
- Service-specific rate limits and billing
- Clear audit trails per service

See [API_KEY_DESIGN.md](./API_KEY_DESIGN.md) for implementation details.

## Database Schema

**Source of truth:** `packages/database/src/schema/` (Drizzle ORM definitions)

The Drizzle schema files are the authoritative reference for all table definitions, column types, constraints, and indexes. Run `npm run db:generate` to produce migrations from schema changes.

**ENUM types:** See [ENUM_IMPLEMENTATION.md](./ENUM_IMPLEMENTATION.md) for PostgreSQL ENUM type definitions and usage.

**Schema files:**

| File | Tables |
|------|--------|
| `schema/customers.ts` | `customers` |
| `schema/auth.ts` | `auth_nonces`, `refresh_tokens` |
| `schema/services.ts` | `service_instances` |
| `schema/escrow.ts` | `escrow_transactions`, `ledger_entries`, `billing_records` |
| `schema/billing.ts` | `invoice_line_items`, `invoice_payments`, `customer_credits`, `customer_payment_methods`, `billing_idempotency` |
| `schema/seal.ts` | `seal_keys`, `seal_packages`, `seal_registration_ops` |
| `schema/api_keys.ts` | `api_keys` |
| `schema/usage.ts` | `usage_records` |
| `schema/logs.ts` | `user_activity_logs`, `haproxy_raw_logs`, `haproxy_system_logs` |
| `schema/system.ts` | `config_global`, `processing_state`, `system_control`, `lm_status` |
| `schema/admin.ts` | `admin_notifications` |
| `schema/cancellation-history.ts` | `service_cancellation_history` |
| `schema/enums.ts` | PostgreSQL ENUM type definitions |
| `schema/mock.ts` | `mock_sui_transactions` (dev/test only) |
| `schema/mock-tracking.ts` | `mock_tracking_objects` (dev/test only) |
| `schema/test-kv.ts` | `test_kv` (dev/test only) |

**Key relationships:**

- `customers` 1:N `service_instances` (one instance per service type per customer)
- `customers` 1:N `billing_records` (invoices: draft/pending/paid/failed/voided)
- `customers` 1:N `ledger_entries` (all financial movements)
- `customers` 1:N `escrow_transactions` (on-chain charge/credit records)
- `billing_records` 1:N `invoice_line_items` (itemized charges)
- `billing_records` 1:N `invoice_payments` (multi-source payment tracking)
- `service_instances` 1:N `seal_keys` 1:N `seal_packages`
- `seal_keys` 1:N `seal_registration_ops` (async on-chain registration queue)
- `service_instances` has `sub_pending_invoice_id` FK → `billing_records` (payment gate)

**For billing/payment schema details**, see [BILLING_DESIGN.md](./BILLING_DESIGN.md) and [PAYMENT_DESIGN.md](./PAYMENT_DESIGN.md).

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
- **CRITICAL: API server NEVER has access to master seeds** — keyservers load `SEAL_MASTER_SEED_*` from `~/.suiftly.env` at runtime
- **Privilege separation**: API stores `derivation_index` only; private keys are derived at runtime by keyservers from master seed + index
- **Per-PG counter atomicity**: `system_control.next_seal_derivation_index_pg{1,2}` uses atomic `UPDATE...RETURNING` — no race conditions or gaps
- Never log full API keys (log only key_id or prefix)
- Encrypt imported Seal private keys with customer's wallet (derived keys store only index)
- Rate limit authentication endpoints (prevent brute force)
- Implement API key rotation reminders
- Monitor for suspicious patterns (rapid key creation)
- Atomic per-PG counter allocation prevents duplicate derivation indices (no DB unique constraint — uniqueness enforced by `system_control` counter)

### Performance Targets
- API key lookup: <1ms (cached), <10ms (DB)
- HAProxy sticky table resolution: <1ms
- JWT validation: <5ms
- Database queries: Indexed for sub-10ms response times

---

**Document Version**: 2.1
**Last Updated**: 2026-02-18

**Changelog:**
- v2.1: Removed stale seal key pool/sequence design, updated to match implemented counter-based derivation:
  - **Removed `seal_key_pool` and `seal_key_sequences`** — replaced with per-PG counters in `system_control`
  - **Rewrote Seal Key Creation Flow** — now documents the actual async registration flow (API creates key → GM registers on-chain)
  - **Updated Seal Key States** — replaced stale states with actual `registrationStatusEnum` (`registering`, `registered`, `updating`)
  - **Updated schema file reference** — `seal.ts` contains `seal_keys`, `seal_packages`, `seal_registration_ops`
- v2.0: Major cleanup — removed stale SQL schema, aligned with implemented billing/payment design:
  - **Removed inline SQL schema** — Drizzle schema (`packages/database/src/schema/`) is the source of truth
  - **Added Database Schema section** with schema file reference table and key relationships
  - **Updated Customer Account Structure** diagram to reflect implemented tables (invoice_payments, customer_payment_methods, customer_credits, escrow_transactions)
  - **Replaced Service Billing section** — removed escrow-hardcoded pseudocode, now references BILLING_DESIGN.md and PAYMENT_DESIGN.md
  - **Updated Balance & Spending Limit Validation** for multi-provider model (service gate checks payment method existence, not just escrow balance)
  - **Added cross-references** to BILLING_DESIGN.md and PAYMENT_DESIGN.md throughout
- v1.17: Consolidated financial tables and clarified billing/ledger relationship
- v1.16: Added per-PG derivation index counters and security architecture
- v1.15: Added user-defined names to seal_keys and seal_packages
- v1.14: Simplified seal_keys schema based on Boneh-Franklin IBE research
- v1.13: Enhanced seal_keys schema for BLS12-381 IBE and derived/imported keys
- v1.12: Optimized seal_keys and seal_packages tables
- v1.11: Refactored API key design to separate document
- v1.10: Simplified caching architecture
- v1.9: Major performance and security improvements
- v1.8-v1.0: Earlier iterations (see git history)
