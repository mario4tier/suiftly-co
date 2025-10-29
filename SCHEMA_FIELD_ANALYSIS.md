# Schema Field Analysis - Field Count & Relationships Review

**Purpose:** Evaluate if tables have too many fields and document all relationships

---

## Table-by-Table Field Analysis

### 1. `customers` (12 fields)

| Field | Purpose | Can Remove? |
|-------|---------|-------------|
| customer_id | Primary key (random 32-bit) | ❌ Required |
| wallet_address | Unique user identity | ❌ Required |
| escrow_contract_id | Link to on-chain escrow | ❌ Required |
| status | active/suspended/closed | ❌ Required (abuse prevention) |
| max_monthly_usd_cents | Spending authorization | ❌ Required (billing) |
| current_balance_usd_cents | Cached from escrow | ❌ Required (billing) |
| current_month_charged_usd_cents | This month spending | ❌ Required (billing) |
| last_month_charged_usd_cents | Last month (for UI display) | ⚠️ **Optional** - UI convenience |
| current_month_start | Billing period tracker | ❌ Required (month reset) |
| created_at | Audit | ❌ Required |
| updated_at | Audit | ⚠️ **Optional** - can use trigger |

**Indexes (3):**
- idx_wallet (lookup by wallet)
- idx_status (find suspended/closed)

**Assessment:**
- **Core fields: 10** (essential)
- **Optional: 2** (last_month_charged_usd_cents, updated_at)
- **Verdict:** ⚠️ Could remove 2 fields if needed, but they're useful

**Relationships:**
- **HAS MANY** service_instances
- **HAS MANY** api_keys
- **HAS MANY** seal_keys
- **HAS MANY** usage_records
- **HAS MANY** escrow_transactions
- **HAS MANY** ledger_entries
- **HAS MANY** billing_records
- **HAS MANY** haproxy_raw_logs
- **HAS MANY** refresh_tokens

---

### 2. `service_instances` (8 fields)

| Field | Purpose | Can Remove? |
|-------|---------|-------------|
| instance_id | Primary key (UUID) | ❌ Required |
| customer_id | FK to customer | ❌ Required |
| service_type | seal/grpc/graphql | ❌ Required |
| tier | starter/pro/enterprise | ❌ Required (pricing) |
| is_enabled | Active/paused | ❌ Required |
| config | JSONB service settings | ⚠️ **Maybe empty for simple services** |
| enabled_at | Audit/billing start | ⚠️ **Could derive from billing_records** |
| disabled_at | Audit/billing end | ⚠️ **Could derive from billing_records** |

**Indexes (1):**
- UNIQUE(customer_id, service_type)

**Assessment:**
- **Core fields: 5**
- **Optional: 3** (config could be empty, timestamps could be derived)
- **Verdict:** ⚠️ Could reduce to 5 fields (remove enabled_at, disabled_at, make config optional)

**Relationships:**
- **BELONGS TO** customers (customer_id)

---

### 3. `api_keys` (12 fields)

| Field | Purpose | Can Remove? |
|-------|---------|-------------|
| api_key_id | Full encrypted key | ❌ Required |
| api_key_fp | Fingerprint (first 7 Base32) | ❌ Required (MA_VAULT) |
| customer_id | FK to customer | ❌ Required |
| service_type | Which service | ❌ Required |
| key_version | Format version | ⚠️ Could default to 1 |
| seal_network | Mainnet/testnet | ⚠️ **Seal-specific** |
| seal_access | Permission/open | ⚠️ **Seal-specific** |
| seal_source | Imported/derived | ⚠️ **Seal-specific** |
| proc_group | Process routing | ⚠️ **Seal-specific** |
| is_active | Revocation support | ❌ Required |
| created_at | Audit | ❌ Required |
| revoked_at | Audit | ❌ Required |

**Indexes (2):**
- idx_customer_service (customer_id, service_type, is_active)
- idx_api_key_fp (api_key_fp) WHERE is_active

**Assessment:**
- **Core fields: 7** (key_id, fp, customer_id, service_type, is_active, created_at, revoked_at)
- **Seal-specific: 5** (seal_network, seal_access, seal_source, proc_group, key_version)
- **Verdict:** ⚠️ **OVER-ENGINEERED for multi-service**

**Problem:** When adding gRPC/GraphQL services, these Seal fields are meaningless.

**Options:**
- A) Keep as-is (set to NULL/0 for non-Seal services)
- B) Move Seal fields to JSONB `metadata` column
- C) Create separate `api_key_seal_metadata` table

**Recommendation:** **Option B** - Replace 5 Seal columns with `metadata JSONB`

**Relationships:**
- **BELONGS TO** customers (customer_id)

---

### 4. `seal_keys` (7 fields)

| Field | Purpose | Can Remove? |
|-------|---------|-------------|
| seal_key_id | Primary key | ❌ Required |
| customer_id | FK to customer | ❌ Required |
| public_key | Blockchain public key | ❌ Required |
| encrypted_private_key | Encrypted key material | ❌ Required |
| purchase_tx_digest | On-chain proof | ⚠️ Audit only |
| is_active | Can be disabled | ❌ Required |
| created_at | Audit | ❌ Required |

**Indexes (1):**
- idx_customer (customer_id)

**Assessment:**
- **Core fields: 7** (all necessary)
- **Optional: 1** (purchase_tx_digest - could be in escrow_transactions)
- **Verdict:** ✅ Minimal, appropriate

**Relationships:**
- **BELONGS TO** customers (customer_id)

---

### 5. `usage_records` (8 fields)

| Field | Purpose | Can Remove? |
|-------|---------|-------------|
| record_id | Primary key | ❌ Required |
| customer_id | FK to customer | ❌ Required |
| service_type | Which service | ❌ Required |
| request_count | Number of requests | ❌ Required (billing) |
| bytes_transferred | Bandwidth used | ❌ Required (billing) |
| window_start | Time window start | ❌ Required |
| window_end | Time window end | ⚠️ Could derive from window_start + interval |
| charged_amount | USD charged | ❌ Required (NULL = not billed yet) |

**Indexes (2):**
- idx_customer_time (customer_id, window_start)
- idx_billing (customer_id, service_type, window_start)

**Assessment:**
- **Core fields: 7**
- **Optional: 1** (window_end could be calculated)
- **Verdict:** ✅ Minimal

**Relationships:**
- **BELONGS TO** customers (customer_id)
- **AGGREGATED FROM** haproxy_raw_logs

---

### 6. `billing_records` (9 fields)

| Field | Purpose | Can Remove? |
|-------|---------|-------------|
| id | Primary key | ❌ Required |
| customer_id | FK to customer | ❌ Required |
| billing_period_start | Period start | ❌ Required |
| billing_period_end | Period end | ⚠️ Could derive from start + interval |
| amount_usd_cents | Charge/credit amount | ❌ Required |
| type | charge/credit/refund | ❌ Required |
| status | pending/paid/failed | ❌ Required |
| tx_digest | Escrow transaction | ❌ Required (NULL if pending) |
| created_at | Audit | ❌ Required |

**Indexes (2):**
- idx_customer_period
- idx_status (WHERE status != 'paid')

**Assessment:**
- **Core fields: 8**
- **Optional: 1** (billing_period_end)
- **Verdict:** ✅ Minimal

**Relationships:**
- **BELONGS TO** customers (customer_id)
- **LINKS TO** escrow_transactions (via tx_digest)
- **BASED ON** usage_records (aggregates usage → charge)

---

### 7. `ledger_entries` (10 fields)

| Field | Purpose | Can Remove? |
|-------|---------|-------------|
| id | Primary key | ❌ Required |
| customer_id | FK to customer | ❌ Required |
| type | deposit/withdrawal/charge/credit | ❌ Required |
| amount_usd_cents | USD amount | ❌ Required |
| amount_sui_mist | SUI amount | ❌ Required (exchange rate calc) |
| sui_usd_rate_cents | Rate at transaction time | ❌ Required (accounting) |
| tx_hash | Blockchain TX | ⚠️ Also in escrow_transactions |
| description | Human-readable | ⚠️ UI convenience |
| invoice_id | Invoice reference | ⚠️ Future feature |
| created_at | Audit | ❌ Required |

**Indexes (2):**
- idx_customer_created
- idx_tx_hash

**Assessment:**
- **Core fields: 7**
- **Optional: 3** (tx_hash duplicate, description, invoice_id)
- **Verdict:** ⚠️ Could remove 2-3 fields

**Relationships:**
- **BELONGS TO** customers (customer_id)
- **OVERLAPS WITH** escrow_transactions (tx_hash)

---

### 8. `escrow_transactions` (7 fields)

| Field | Purpose | Can Remove? |
|-------|---------|-------------|
| tx_id | Primary key | ❌ Required |
| customer_id | FK to customer | ❌ Required |
| tx_digest | Blockchain TX hash | ❌ Required |
| tx_type | deposit/withdraw/charge/credit | ❌ Required |
| amount | USD amount | ❌ Required |
| asset_type | Coin type (SUI) | ⚠️ Always SUI for now |
| timestamp | When it happened | ❌ Required |

**Indexes (2):**
- idx_customer
- idx_tx_digest (UNIQUE)

**Assessment:**
- **Core fields: 7**
- **Optional: 1** (asset_type - always SUI for now, but future-proofs for multi-coin)
- **Verdict:** ✅ Minimal

**Relationships:**
- **BELONGS TO** customers (customer_id)
- **MIRRORED IN** ledger_entries

---

### 9. `haproxy_raw_logs` (21 fields) ⚠️ COMPLEX

| Field | Purpose | Can Remove? |
|-------|---------|-------------|
| timestamp | When | ❌ Required |
| customer_id | Who (NULL if unauth) | ❌ Required |
| path_prefix | URL path (first 10 chars) | ⚠️ Debug only |
| config_hex | Customer config snapshot | ⚠️ Debug only |
| network | testnet/mainnet | ❌ Required (billing per network) |
| server_id | Which server | ⚠️ Ops monitoring |
| service_type | Seal/SSFN/Sealo | ❌ Required (billing) |
| api_key_fp | Which key used | ⚠️ Audit/debug |
| fe_type | Frontend type | ⚠️ Ops monitoring |
| traffic_type | guaranteed/burst/denied | ⚠️ Ops/QoS |
| event_type | error codes | ⚠️ Ops monitoring |
| client_ip | Real IP | ⚠️ Abuse detection |
| key_metadata | Key metadata | ⚠️ Advanced features |
| status_code | HTTP status | ⚠️ Error tracking |
| bytes_sent | Response size | ❌ Required (billing) |
| time_total | Total time | ⚠️ Performance monitoring |
| time_request | Request time | ⚠️ Performance monitoring |
| time_queue | Queue time | ⚠️ Performance monitoring |
| time_connect | Connect time | ⚠️ Performance monitoring |
| time_response | Response time | ⚠️ Performance monitoring |
| backend_id | Which backend | ⚠️ Ops routing |
| termination_state | HAProxy code | ⚠️ Ops debugging |

**Indexes (7):**
- idx_customer_time, idx_server_time, idx_service_network
- idx_traffic_type, idx_event_type, idx_status_code, idx_api_key_fp

**Assessment:**
- **Billing fields: 4** (timestamp, customer_id, service_type, bytes_sent, network)
- **Ops monitoring: 12** (server_id, timing fields, event_type, backend_id, etc.)
- **Debug: 5** (path_prefix, config_hex, client_ip, api_key_fp, termination_state)
- **Verdict:** ⚠️ **COMPLEX but inherited from walrus**

**Question:** Do we need all 21 fields, or can we simplify?

**Analysis:**
- **For billing:** Only need 5 fields (timestamp, customer_id, service_type, network, bytes_sent)
- **For ops:** Need all timing, error, routing fields (walrus requirement)
- **Retention:** 2 days (then deleted, aggregates preserve billing data)

**Options:**
- A) Keep all 21 fields (matches walrus, full debugging capability)
- B) Simplify to 8-10 fields (billing + basic errors only)
- C) Use two tables: haproxy_billing_logs (simple) + haproxy_debug_logs (complex, optional)

**User Decision:** ✅ **Keep all 21 fields** - Full walrus compatibility required

**Reasoning:**
- Walrus infrastructure needs all fields for ops monitoring
- 2-day retention keeps storage minimal
- Aggregates preserve long-term billing data
- Cannot simplify without breaking walrus integration

**Relationships:**
- **BELONGS TO** customers (customer_id) - NULL if unauthenticated
- **AGGREGATED INTO** usage_records (by Global Manager)

---

### 10. `auth_nonces` (3 fields)

| Field | Purpose | Can Remove? |
|-------|---------|-------------|
| address | Wallet (PK) | ❌ Required |
| nonce | Challenge string | ❌ Required |
| created_at | TTL expiry (5 min) | ❌ Required |

**Assessment:** ✅ **Minimal** (3 fields, all necessary)

**Relationships:** None (ephemeral data)

---

### 11. `refresh_tokens` (5 fields)

| Field | Purpose | Can Remove? |
|-------|---------|-------------|
| id | Primary key | ❌ Required |
| customer_id | FK to customer | ❌ Required |
| token_hash | Token identifier | ❌ Required |
| expires_at | TTL (30 days) | ❌ Required |
| created_at | Audit | ⚠️ Optional |

**Assessment:** ✅ **Minimal** (4 core + 1 optional)

**Relationships:**
- **BELONGS TO** customers (customer_id)

---

### 12. `usage_records` (8 fields) - Already analyzed above

---

### 13. `billing_records` (9 fields) - Already analyzed above

---

### 14. `ledger_entries` (10 fields) - Already analyzed above

---

### 15. `escrow_transactions` (7 fields) - Already analyzed above

---

### 16. `seal_keys` (7 fields) - Already analyzed above

---

### 17. `processing_state` (3 fields)

| Field | Purpose | Can Remove? |
|-------|---------|-------------|
| key | State name (PK) | ❌ Required |
| value | State value | ❌ Required |
| updated_at | When last updated | ❌ Required |

**Assessment:** ✅ **Minimal** (3 fields, all necessary)

**Relationships:** None (system state)

---

### 18. `system_control` (6 fields)

| Field | Purpose | Can Remove? |
|-------|---------|-------------|
| id | Singleton PK (always 1) | ❌ Required |
| ma_vault_version | Deployed version | ❌ Required |
| mm_vault_version | Deployed version | ⚠️ Only if using MM_VAULT |
| last_monthly_reset | Billing reset date | ❌ Required |
| maintenance_mode | Feature flag | ⚠️ Nice-to-have |
| updated_at | Audit | ❌ Required |

**Assessment:** ✅ **Minimal** (4 core + 2 optional)

**Relationships:** None (singleton)

---

## Field Count Summary

| Table | Total Fields | Core | Optional | Verdict |
|-------|--------------|------|----------|---------|
| customers | 12 | 10 | 2 | ✅ OK |
| service_instances | 8 | 5 | 3 | ⚠️ Could simplify |
| api_keys | 12 | 7 | 5 | ⚠️ Seal-specific bloat |
| seal_keys | 7 | 7 | 0 | ✅ Minimal |
| usage_records | 8 | 7 | 1 | ✅ OK |
| billing_records | 9 | 8 | 1 | ✅ OK |
| ledger_entries | 10 | 7 | 3 | ⚠️ Could simplify |
| escrow_transactions | 7 | 6 | 1 | ✅ Minimal |
| haproxy_raw_logs | 21 | 5 billing + 16 ops | ? | ⚠️ Complex (walrus) |
| auth_nonces | 3 | 3 | 0 | ✅ Minimal |
| refresh_tokens | 5 | 4 | 1 | ✅ Minimal |
| processing_state | 3 | 3 | 0 | ✅ Minimal |
| system_control | 6 | 4 | 2 | ✅ OK |

**Average:** 8.5 fields per table

---

## Table Relationships (ERD)

```
┌─────────────────────────────────────────────────────────────┐
│                         CUSTOMERS                            │
│  customer_id (PK)                                            │
│  wallet_address (UNIQUE)                                     │
│  status, balance, monthly_limit, ...                         │
└─────────────┬───────────────────────────────────────────────┘
              │
              ├─── HAS MANY ──→ service_instances (customer_id FK)
              │                   ↓ tier → rate limits (derived)
              │
              ├─── HAS MANY ──→ api_keys (customer_id FK)
              │                   ↓ api_key_fp → MA_VAULT
              │
              ├─── HAS MANY ──→ seal_keys (customer_id FK)
              │                   ↓ Seal blockchain keys
              │
              ├─── HAS MANY ──→ usage_records (customer_id FK)
              │                   ↑ AGGREGATED FROM haproxy_raw_logs
              │
              ├─── HAS MANY ──→ billing_records (customer_id FK)
              │                   ↓ TRIGGERS → escrow charge
              │                   ↓ CREATES → ledger_entry
              │
              ├─── HAS MANY ──→ ledger_entries (customer_id FK)
              │                   ↓ SUI/USD rates at transaction time
              │
              ├─── HAS MANY ──→ escrow_transactions (customer_id FK)
              │                   ↓ Mirror of on-chain events
              │
              ├─── HAS MANY ──→ haproxy_raw_logs (customer_id FK, nullable)
              │                   ↓ 2-day retention, aggregated hourly
              │
              └─── HAS MANY ──→ refresh_tokens (customer_id FK)
                                  ↓ JWT session revocation

┌──────────────────────────────────────┐
│      STANDALONE (No FKs)             │
├──────────────────────────────────────┤
│ auth_nonces         (ephemeral)      │
│ processing_state    (worker state)   │
│ system_control      (singleton)      │
└──────────────────────────────────────┘
```

---

## Relationship Analysis

### **Customer-Centric Design:**
- ✅ All tables (except 3 standalone) reference `customers.customer_id`
- ✅ Clean fan-out: 1 customer → many services/keys/transactions
- ✅ No circular dependencies
- ✅ Straightforward foreign keys

### **Data Flow:**

```
1. Customer authenticates → auth_nonces, refresh_tokens
2. Customer enables service → service_instances
3. Customer generates API key → api_keys
4. Customer purchases Seal key → seal_keys, escrow_transactions, ledger_entries
5. Customer makes requests → haproxy_raw_logs
6. Global Manager aggregates logs → usage_records
7. Global Manager calculates billing → billing_records
8. Billing charged to escrow → escrow_transactions, ledger_entries
```

---

## Issues Found

### ✅ **1. api_keys table - SIMPLIFIED (12 → 7 fields)**
**Problem:** 5 Seal-specific fields won't apply to gRPC/GraphQL
- seal_network, seal_access, seal_source, proc_group, key_version

**User Decision:** ✅ **Use metadata JSONB** (flexibility is key)

**New Schema:**
```sql
CREATE TABLE api_keys (
  api_key_id VARCHAR(100) PRIMARY KEY,
  api_key_fp VARCHAR(64) NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  service_type VARCHAR(20) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',    -- Service-specific fields
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP NULL
);
```

**Metadata structure by service:**
- **Seal:** `{key_version, seal_network, seal_access, seal_source, proc_group}`
- **gRPC:** TBD (can add fields without schema migration)
- **GraphQL:** TBD (can add fields without schema migration)

**Benefits:**
- ✅ Flexible for new services
- ✅ No NULL columns for non-applicable fields
- ✅ Can evolve metadata without ALTER TABLE
- ✅ Reduced from 12 to 7 fields

### ✅ **2. haproxy_raw_logs - KEEP ALL 21 FIELDS**
**Analysis:** Very complex - 21 fields for logging

**User Decision:** ✅ **Keep all 21 fields** - Full walrus compatibility required

**Reasoning:**
- Walrus infrastructure depends on all fields for ops monitoring
- Cannot simplify without breaking integration
- 2-day retention keeps storage impact minimal
- Continuous aggregates preserve billing data long-term

**Verdict:** ✅ Complexity justified by walrus integration requirements

### ⚠️ **3. Minor field redundancies**
- `service_instances.enabled_at/disabled_at` - could derive from billing_records
- `ledger_entries.tx_hash` - duplicates escrow_transactions.tx_digest
- `usage_records.window_end` - could calculate from window_start

**Impact:** ~5 fields across 3 tables
**Recommendation:** Low priority - these are convenience fields

---

## Recommendations

### ✅ **Decisions Made:**

**1. haproxy_raw_logs (21 fields)** - ✅ KEEP ALL
- Full walrus compatibility required
- All fields needed for ops monitoring

**2. api_keys Seal-specific fields** - ✅ MOVE TO JSONB
- Changed: 5 Seal columns → 1 `metadata JSONB` column
- **Benefit:** Flexible for multi-service (Seal, gRPC, GraphQL)
- **Result:** Reduced from 12 to 7 fields

### **Low Priority (Defer):**

Remove minor redundancies:
- service_instances timestamps
- ledger_entries.tx_hash
- usage_records.window_end

---

## Final Results

**Simplified:**
- api_keys: 12 → 7 fields (moved Seal metadata to JSONB)

**Kept as-is:**
- haproxy_raw_logs: 21 fields (walrus compatibility required)
- All other tables: Already minimal

**New Average:** 7.5 fields per table (down from 8.5)

**Verdict:** ✅ Schema is now lean, flexible, and optimized for multi-service growth
