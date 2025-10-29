# Database Tables Review - Over-Engineering Check

**Total Tables:** 7 core + 2 optional (from GLOBAL_MANAGER appendix)

---

## Core Tables (Required for MVP)

### 1. `customers` - Customer Accounts
**Purpose:** One row per wallet, tracks identity and billing state

**Columns (12):**
- `customer_id` - Random 32-bit ID (not wallet address for privacy)
- `wallet_address` - Sui wallet (0x...)
- `escrow_contract_id` - On-chain escrow object
- `status` - active/suspended/closed
- `max_monthly_usd_cents` - Monthly spending authorization (NULL = unlimited)
- `current_balance_usd_cents` - Cached balance from escrow
- `current_month_charged_usd_cents` - Spending this month
- `last_month_charged_usd_cents` - Last month (for UI display)
- `current_month_start` - Billing period start date
- `created_at`, `updated_at` - Audit timestamps

**Critical?** ✅ YES - Core entity, cannot simplify further
**Over-engineered?** ❌ NO - All fields necessary for billing/auth

---

### 2. `service_instances` - Service Configurations
**Purpose:** Which services each customer has enabled and at what tier

**Columns (8):**
- `instance_id` - UUID primary key
- `customer_id` - FK to customers
- `service_type` - 'seal', 'grpc', 'graphql'
- `tier` - 'starter', 'pro', 'enterprise'
- `is_enabled` - Active/paused
- `config` - JSONB for service-specific settings
- `enabled_at`, `disabled_at` - Audit timestamps

**Critical?** ✅ YES - Need to track which services customer has
**Over-engineered?** ⚠️ MAYBE - Could merge tier into customers table if only ever 1 service?

**Analysis:**
- UNIQUE(customer_id, service_type) = max 3 services per customer
- For single service (Seal only), could put tier in customers table
- But future: gRPC, GraphQL = multiple services needed
- **Verdict:** Keep it - future-proofs for multi-service

---

### 3. `api_keys` - API Authentication Keys
**Purpose:** HTTP authentication for service requests (X-API-Key header)

**Columns (12):**
- `api_key_id` - Full encrypted key string
- `api_key_fp` - Fingerprint (first 7 Base32 chars → 32-bit)
- `customer_id` - FK to customers
- `service_type` - Which service this key is for
- `key_version` - API key format version
- `seal_network` - Mainnet/testnet (Seal-specific)
- `seal_access` - Permission/open (Seal-specific)
- `seal_source` - Imported/derived (Seal-specific)
- `proc_group` - Process group for routing
- `is_active` - Revoked keys stay in DB
- `created_at`, `revoked_at` - Audit

**Critical?** ✅ YES - Required for API authentication
**Over-engineered?** ⚠️ MAYBE - Too many Seal-specific columns?

**Analysis:**
- 5 columns are Seal-specific (seal_network, seal_access, seal_source, proc_group, key_version)
- For multi-service (gRPC, GraphQL), these fields won't apply
- Could move Seal-specific data to JSONB column?

**Options:**
- Option A (current): Explicit columns for Seal metadata
- Option B: Generic `metadata JSONB` column, fewer typed columns
- Option C: Separate `api_key_seal_metadata` table

**Verdict:** ⚠️ **Slight over-engineering** - Could use JSONB for service-specific fields

---

### 4. `seal_keys` - Seal Encryption Keys
**Purpose:** Store blockchain key pairs for Seal storage encryption

**Columns (7):**
- `seal_key_id` - UUID
- `customer_id` - FK to customers
- `public_key` - Sui public key
- `encrypted_private_key` - Encrypted with customer wallet
- `purchase_tx_digest` - On-chain purchase proof
- `is_active` - Can be disabled
- `created_at` - Audit

**Critical?** ✅ YES - Seal requires blockchain keys for encryption
**Over-engineered?** ❌ NO - Minimal for Seal key management

**Analysis:**
- Seal-specific table (gRPC/GraphQL won't use this)
- Keeps concerns separated (API keys vs Seal keys)
- **Verdict:** ✅ Appropriate separation

---

### 5. `usage_records` - Aggregated Usage for Billing
**Purpose:** Aggregated request/bandwidth data from haproxy_raw_logs for billing

**Columns (8):**
- `record_id` - Auto-increment
- `customer_id` - FK to customers
- `service_type` - Which service
- `request_count` - Number of requests
- `bytes_transferred` - Total bandwidth
- `window_start`, `window_end` - Time window (e.g., hourly)
- `charged_amount` - USD charged for this window (NULL = not yet billed)

**Critical?** ✅ YES - Need to bill customers
**Over-engineered?** ❌ NO - Minimal billing data

**Analysis:**
- Aggregated from haproxy_raw_logs (which are deleted after 2 days)
- Preserves billing data long-term
- **Verdict:** ✅ Necessary for billing audit trail

---

### 6. `escrow_transactions` - On-Chain Event Mirror
**Purpose:** Off-chain copy of on-chain escrow events (deposits, withdrawals, charges)

**Columns (7):**
- `tx_id` - Auto-increment
- `customer_id` - FK to customers
- `tx_digest` - Blockchain TX hash (UNIQUE)
- `tx_type` - 'deposit', 'withdraw', 'charge', 'credit'
- `amount` - USD amount
- `asset_type` - Coin type (e.g., SUI)
- `timestamp` - When it happened

**Critical?** ✅ YES - Audit trail of all money movement
**Over-engineered?** ❌ NO - Essential for compliance/debugging

**Analysis:**
- Mirrors on-chain events to off-chain DB
- Prevents re-querying blockchain for history
- **Verdict:** ✅ Necessary audit log

---

### 7. `haproxy_raw_logs` - Request Logs (TimescaleDB)
**Purpose:** Every HTTP request for metering, debugging, ops monitoring

**Columns (21):**
- `timestamp` - When request happened
- `customer_id` - Who made request (NULL if unauthenticated)
- `path_prefix` - First 10 chars of URL
- `config_hex` - Customer config snapshot
- `network`, `server_id`, `service_type` - Infrastructure context
- `api_key_fp` - Which API key used
- `fe_type`, `traffic_type`, `event_type` - Request classification
- `client_ip` - Real IP
- `key_metadata` - API key metadata
- `status_code` - HTTP response
- `bytes_sent` - Response size
- `time_total`, `time_request`, `time_queue`, `time_connect`, `time_response` - Performance metrics
- `backend_id`, `termination_state` - Backend routing info

**Critical?** ✅ YES - Required for usage metering (billing source)
**Over-engineered?** ⚠️ MAYBE - 21 columns is a lot

**Analysis:**
- **Metering needs:** customer_id, service_type, bytes_sent, timestamp (4 columns)
- **Debugging needs:** All timing, error codes, IPs (another 10+ columns)
- **Ops monitoring:** server_id, backend_id, event_type (5+ columns)
- Retention: 2 days raw, aggregated for long-term

**But:**
- This table comes from walrus (production-tested)
- Many columns needed for continuous aggregates
- **Verdict:** ⚠️ **Looks complex but justified** - walrus needs this for ops

---

---

## Additional Tables Found in Docs (Need Reconciliation)

### 8. `auth_nonces` - Wallet Authentication (AUTHENTICATION_DESIGN.md)
**Purpose:** Prevent replay attacks in wallet signature authentication

**Columns:**
- `address` - Wallet address
- `nonce` - Random challenge string
- `created_at` - Expiry tracking (5-minute TTL)

**Critical?** ✅ YES - Required for secure wallet auth
**Over-engineered?** ❌ NO - Minimal anti-replay protection

**Analysis:**
- Ephemeral data (5-minute lifetime)
- Could use Redis/in-memory instead of PostgreSQL?
- **Verdict:** ✅ Keep - but consider in-memory store for performance

---

### 9. `refresh_tokens` - JWT Session Management (AUTHENTICATION_DESIGN.md)
**Purpose:** Track refresh tokens for revocation capability

**Columns:**
- `id`, `customer_id`, `token_hash`
- `expires_at`, `created_at`

**Critical?** ✅ YES - Needed to revoke compromised sessions
**Over-engineered?** ❌ NO - Standard practice for JWT

**Analysis:**
- Required for logout/session revocation
- **Verdict:** ✅ Necessary

---

### 10. `processing_state` - Global Manager State (GLOBAL_MANAGER_DESIGN.md)
**Purpose:** Track last processed position (e.g., last log timestamp)

**Columns:**
- `key` - State key (e.g., 'last_log_processed')
- `value` - Timestamp or value
- `updated_at`

**Critical?** ✅ YES - Prevents reprocessing logs
**Over-engineered?** ❌ NO - Standard pattern for workers

**Analysis:**
- Idempotency mechanism
- **Verdict:** ✅ Necessary for resumable processing

---

### 11. `service_status` - Service Health History (Renamed from worker_runs)
**Purpose:** Historical daemon health and service uptime tracking

**Columns (User Decision - Renamed):**
- `id` - Auto-increment
- `service_name` - 'global-manager', 'api-server', 'webapp', etc.
- `started_at` - Service start time
- `completed_at` - Service stop time (NULL if still running)
- `status` - 'running', 'stopped', 'error', 'crashed'
- `error_message` - Error details if status = error/crashed
- `created_at`

**Critical?** ⚠️ NICE-TO-HAVE - Better than logs for uptime tracking
**Over-engineered?** ⚠️ MAYBE - Could use systemd journal instead

**Analysis (User Input):**
- Better name: `service_status` (not just worker, includes API/webapp)
- Useful for uptime dashboard (service availability %)
- Alternative: Query systemd journal or use external monitoring

**Verdict:** ⚠️ **Optional for MVP** - Can add post-launch for ops dashboard

---

### 12. `usage_hourly` - Hourly Aggregates (GLOBAL_MANAGER_DESIGN.md)
**Purpose:** Pre-aggregated hourly usage stats

**Columns:**
- `hour`, `customer_id`, `service_type`
- `request_count`, `bytes_total`

**Critical?** ⚠️ DUPLICATION - Overlaps with usage_records?
**Over-engineered?** ✅ YES - DUPLICATE

**Analysis:**
- `usage_records` already does this (configurable window)
- **Verdict:** ❌ **REMOVE** - Use usage_records instead

---

### 13. `billing_records` - Charges & Credits (GLOBAL_MANAGER_DESIGN.md)
**Purpose:** Track charges and credits applied to customer accounts

**Columns:**
- `id`, `customer_id`, `billing_period_start`, `billing_period_end`
- `amount_usd_cents`, `status` (pending/paid)
- `type` (charge/credit/refund)
- `created_at`

**Critical?** ✅ YES - Different from usage logs
**Over-engineered?** ❌ NO - Tracks financial actions

**Analysis (User Clarification):**
- **NOT the same as usage logs** (haproxy_raw_logs)
- Usage logs = raw request data (bytes, timing)
- Billing records = financial actions (charges, credits, refunds)
- Status: pending (calculated) → paid (charged to escrow)
- Example: "Charge $50 for 1M requests" (pending) → "Charged $50, tx_digest: 0x..." (paid)

**Verdict:** ✅ **KEEP** - Essential for billing workflow (pending → paid transition)

---

### 14. `customer_limits` - Rate Limits (GLOBAL_MANAGER_DESIGN.md)
**Purpose:** Per-customer rate limits

**Columns:**
- `customer_id`, `guaranteed_rps`, `burst_rps`, `burst_duration_sec`, `status`

**Critical?** ❌ NO - DUPLICATION
**Over-engineered?** ✅ YES - UNNECESSARY

**Analysis:**
- Rate limits come from `service_instances.tier` (starter/pro/enterprise)
- Tier → limits mapping is in SEAL_SERVICE_CONFIG.md (static config)
- **Verdict:** ❌ **REMOVE** - Use tier-based limits, not per-customer table

---

### 15. `system_control` - System-Wide Singleton State (Redesigned)
**Purpose:** Store singleton values (only one row) for system-wide state

**Columns (User Decision - Redesign):**
- `id` - Always 1 (singleton constraint)
- `ma_vault_version` - Expected MA_VAULT version deployed to infrastructure
- `mm_vault_version` - Expected MM_VAULT version (if used)
- `last_monthly_reset` - Last calendar month reset date (for billing)
- `maintenance_mode` - Boolean (pause new signups during maintenance)
- `updated_at`

**Critical?** ✅ YES - Better than vault_versions table
**Over-engineered?** ❌ NO - Practical singleton pattern

**Analysis (User Input):**
- Don't need historical vault versions - only care about current/expected version
- Singleton table (1 row) more appropriate than version history
- Can add other system-wide flags (maintenance mode, feature flags, etc.)

**Verdict:** ✅ **KEEP** - Redesigned as singleton control table

**Schema:**
```sql
CREATE TABLE system_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- Singleton: only 1 row allowed
  ma_vault_version VARCHAR(64),
  mm_vault_version VARCHAR(64),
  last_monthly_reset DATE,
  maintenance_mode BOOLEAN DEFAULT false,
  updated_at TIMESTAMP NOT NULL
);
```

---

### 16. `customer_encryption_keys` - MM_VAULT (Optional)
**Purpose:** Customer-imported encryption keys for advanced Seal use cases

**Columns (9):**
- `id`, `customer_id`, `key_id`, `key_type`
- `encrypted_key_material`, `metadata`, `status`
- `created_at`, `updated_at`

**Critical?** ❌ NO - Appendix feature, not in MVP
**Over-engineered?** N/A - Optional future feature
**Verdict:** ⏸️ **Defer** - Implement only if needed

---

### 17. `ledger_entries` - Financial Ledger (ESCROW_DESIGN.md)
**Purpose:** SUI/USD exchange rate history at transaction time

**Columns (9):**
- `id`, `customer_id`, `type`
- `amount_usd_cents`, `amount_sui_mist`, `sui_usd_rate_cents`
- `tx_hash`, `description`, `invoice_id`, `created_at`

**Critical?** ✅ YES - Need SUI/USD rates at different points in time
**Over-engineered?** ❌ NO - Separate concern from blockchain events

**Analysis (User Decision):**
- `escrow_transactions` = Mirror of on-chain events (tx_digest, amount, timestamp)
- `ledger_entries` = Accounting detail (SUI amount, USD rate at that moment, invoice_id)
- **Key difference:** Exchange rates change over time, need historical snapshot
- Example: Deposit on Jan 1 (1 SUI = $2.00), Deposit on Jan 15 (1 SUI = $2.50)

**Verdict:** ✅ **KEEP SEPARATE** - Different concerns (blockchain vs accounting)

---

## Over-Engineering Assessment

### ✅ **Appropriately Engineered (Keep As-Is):**
1. `customers` - Core entity, all fields necessary
2. `seal_keys` - Minimal for Seal blockchain keys
3. `usage_records` - Necessary billing aggregates
4. `escrow_transactions` - Audit trail required
5. `haproxy_raw_logs` - Complex but justified (walrus production needs)

### ⚠️ **Potential Over-Engineering:**

#### **Minor Issue: api_keys table**
- **Problem:** 5 Seal-specific columns won't apply to gRPC/GraphQL keys
- **Options:**
  - Current: Explicit typed columns (easier queries, schema validation)
  - Alternative: Move to JSONB `metadata` column (more flexible)
- **Impact:** Low - only ~30 bytes per row difference
- **Recommendation:** **Keep as-is** - explicit columns are self-documenting

#### **Possible Duplication: ledger_entries vs escrow_transactions**
- **Problem:** Two tables tracking similar data (financial transactions)
- **Question:** Do we need both?
- **Possible solution:** Merge into single table, or clarify distinct purposes

---

## Recommendations

### ✅ **Keep:**
- All 7 core tables (appropriate complexity)
- api_keys Seal-specific columns (self-documenting, validated at schema level)
- haproxy_raw_logs complexity (inherited from walrus, production-tested)

### ⚠️ **Clarify:**
- **ledger_entries vs escrow_transactions** - Are both needed? If yes, document clear distinction

### ❌ **No Major Over-Engineering Found**

The schema is **lean and purposeful**. Most complexity comes from:
1. Real-world requirements (multi-service, billing, audit trails)
2. Walrus integration (haproxy_raw_logs)
3. Blockchain integration (escrow sync, Seal keys)

---

## Table Relationships

```
customers (1)
├── service_instances (0-3) - Which services enabled
├── api_keys (0-20) - HTTP auth keys per service
├── seal_keys (0-N) - Blockchain keys for Seal (purchasable)
├── usage_records (0-N) - Billing aggregates
├── escrow_transactions (0-N) - Payment history
└── haproxy_raw_logs (0-N) - Request logs (2-day retention)
```

**Cardinality:**
- 1 customer → 0-3 services (Seal, gRPC, GraphQL)
- 1 service → 1-20 API keys (mostly 1-2, up to 20 for enterprise)
- 1 customer → 0-N Seal keys (purchasable, $10/month after first)

---

---

## Summary

**Total Tables Found:** 17

### ✅ **Core Schema (7 tables) - KEEP:**
1. `customers` - Customer accounts ✅
2. `service_instances` - Service configs ✅
3. `api_keys` - API authentication ✅
4. `seal_keys` - Seal blockchain keys ✅
5. `usage_records` - Billing aggregates ✅
6. `escrow_transactions` - Payment history ✅
7. `haproxy_raw_logs` - Request logs ✅

### ✅ **Auth Tables (2 tables) - KEEP:**
8. `auth_nonces` - Anti-replay ✅
9. `refresh_tokens` - Session revocation ✅

### ✅ **Worker Tables (1 table) - KEEP:**
10. `processing_state` - Resumable processing ✅

### ⚠️ **Optional/Monitoring (3 tables) - LOW PRIORITY:**
11. `worker_runs` - Daemon health (can use logs instead)
12. `billing_records` - Billing audit (can use logs instead)
13. `vault_versions` - MA_VAULT history (can use file timestamps)

### ❌ **Duplicates to Remove (1 table):**
14. `customer_limits` - ❌ REMOVE (use service_instances.tier instead)

### ⚠️ **Needs Decision (2 tables):**
15. `usage_hourly` - ⚠️ Duplicate of usage_records? Or different granularity?
16. `ledger_entries` - ⚠️ Merge with escrow_transactions or keep separate?

### ⏸️ **Future/Optional (1 table):**
17. `customer_encryption_keys` - ⏸️ Defer (MM_VAULT appendix feature)

---

## Over-Engineering Score

**Core Schema (7 tables):** ✅ **0/10** - Lean and necessary
**Auth + Worker (3 tables):** ✅ **1/10** - Standard patterns
**Monitoring tables (3):** ⚠️ **5/10** - Nice-to-have, could simplify
**Duplicates (1):** ❌ **10/10** - Clear over-engineering

---

## Final Recommendations (Based on User Decisions)

### ❌ **Remove (2 tables):**
1. `customer_limits` - Use tier-based limits from service_instances.tier
2. `usage_hourly` - Duplicate of usage_records (use hourly windows in usage_records)

### ✅ **Keep All Core Tables (13 tables for MVP):**

**Customer & Service (4):**
1. `customers` - With status column ✅
2. `service_instances` - Service configs ✅
3. `api_keys` - With api_key_fp column ✅
4. `seal_keys` - Seal blockchain keys ✅

**Financial (3):**
5. `usage_records` - Usage aggregates ✅
6. `billing_records` - Charges/credits (pending→paid) ✅
7. `ledger_entries` - SUI/USD exchange rate history ✅
8. `escrow_transactions` - Blockchain event mirror ✅

**Logs & Auth (3):**
9. `haproxy_raw_logs` - Request logs (2-day retention) ✅
10. `auth_nonces` - Anti-replay ✅
11. `refresh_tokens` - Session revocation ✅

**System (2):**
12. `processing_state` - Worker resumability ✅
13. `system_control` - Singleton (vault versions, monthly reset, etc.) ✅

### ⏸️ **Defer to Post-MVP (2 tables):**
14. `service_status` - Service health history (use systemd journal for now)
15. `customer_encryption_keys` - MM_VAULT (future feature)

---

## Final Verdict

**MVP Schema:** ✅ **13 tables** - Lean, purposeful, not over-engineered

**Removed:** 2 duplicates (customer_limits, usage_hourly)
**Redesigned:** 1 table (vault_versions → system_control singleton)
**Renamed:** 1 table (worker_runs → service_status, deferred)
**Clarified:** All table purposes now clear

**Over-Engineering Score:** ✅ **2/10** - Excellent design, minimal bloat
