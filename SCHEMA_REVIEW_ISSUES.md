# Schema Review - Critical Issues Found

**Reviewer:** Claude Code + GitHub Copilot
**Date:** 2025-10-28
**Status:** 🚨 BLOCKING - Must resolve before Phase 2

---

## Critical Issues (Must Fix Before Implementation)

### 1. Monthly Spending Limit Contradictions ⚠️ CRITICAL

**Two incompatible models defined:**

| Document | Default | Range | Reset Model | Event |
|----------|---------|-------|-------------|-------|
| CUSTOMER_SERVICE_SCHEMA.md | **$200** | **$20 to "no limit"** | **Calendar month** | `MonthlyReset` event |
| ESCROW_DESIGN.md | **$2,000** | **$100 to $50,000** | **30-day rolling window** | No reset event needed |

**Impact:**
- Smart contract implementation depends on this choice
- Billing logic completely different (calendar vs rolling)
- 10x difference in default protection ($200 vs $2,000)

**Decision Required:**
- [ ] Use **30-day rolling window** ($2,000 default, $100-$50k range) - ESCROW_DESIGN.md model
- [ ] Use **calendar month** ($200 default, $20-no limit range) - CUSTOMER_SERVICE_SCHEMA.md model
- [ ] Pick a third option

**Recommendation:** **30-day rolling window** model from ESCROW_DESIGN.md because:
- ✅ Prevents gaming (can't wait for month rollover)
- ✅ More predictable user experience
- ✅ $2,000 default is more reasonable for real usage
- ✅ $100 minimum prevents abuse better than $20

---

### 2. Missing Schema Columns for Global Manager ⚠️ CRITICAL

**GLOBAL_MANAGER_DESIGN.md expects these fields that DON'T EXIST in schema:**

| Field | Used In | Current Schema |
|-------|---------|----------------|
| `customers.status` | MA_VAULT generation (line 397) | ❌ Not defined |
| `customers.tier` | MA_VAULT generation (line 412) | ❌ Not defined |
| `customer.api_keys.key_hash` | MA_VAULT generation (line 411) | ❌ Schema has `api_key_id`, not `key_hash` |
| `customer.limits` (table/relation) | MA_VAULT generation (lines 414-418) | ❌ Not defined |

**Impact:**
- Global Manager code cannot be implemented as documented
- MA_VAULT generation will fail

**Decision Required:**
- [ ] Add these columns to `customers` table: `status`, `tier`
- [ ] Create `customer_limits` table for rate limits
- [ ] Change `api_keys.api_key_id` to store hashed keys, or add `key_hash` column
- [ ] OR: Simplify GLOBAL_MANAGER_DESIGN to use existing schema

**Recommendation:** Add minimal fields needed:
```sql
ALTER TABLE customers ADD COLUMN status VARCHAR(20) DEFAULT 'active';
-- Don't add tier - it's in service_instances.tier already
```

For rate limits - use `service_instances.tier` to look up limits (already exists).
For `key_hash` - store HMAC output from API_KEY_DESIGN.md in `api_keys` table.

---

### 3. Customer ID Type Mismatch ⚠️ CRITICAL

**GLOBAL_MANAGER_DESIGN.md Appendix (MM_VAULT section):**
```sql
customer_encryption_keys (
  customer_id UUID REFERENCES customers(id)  -- ❌ WRONG
)
```

**Actual schema:**
```sql
customers (
  customer_id INTEGER PRIMARY KEY  -- ✅ CORRECT (32-bit random)
)
```

**Impact:**
- FK constraint invalid
- MM_VAULT schema cannot be created

**Fix:** Change appendix to use `customer_id INTEGER REFERENCES customers(customer_id)`

---

### 4. HAProxy Logs Column Name Mismatches ⚠️ MODERATE

**GLOBAL_MANAGER_DESIGN.md expects:**
- `haproxy_logs` (simple table with `bytes_in`, `endpoint`, `service_type TEXT`)

**Actual schema (CUSTOMER_SERVICE_SCHEMA.md):**
- `haproxy_raw_logs` (comprehensive with `bytes_sent`, `path_prefix`, `service_type SMALLINT`)

**Status:** ✅ Already fixed in previous commit (8f7fc61)

**Action Needed:** Update GLOBAL_MANAGER_DESIGN.md aggregation queries to use correct column names

---

### 5. API Key Storage Method Unclear ⚠️ MODERATE

**Two approaches mentioned:**

1. **API_KEY_DESIGN.md:** Store full encrypted key in `api_key_id` column
2. **GLOBAL_MANAGER_DESIGN.md:** Reference `key_hash` column (doesn't exist)

**Decision Required:**
- [ ] Store full key (current schema) - allows key regeneration/export
- [ ] Store hash only - more secure, but can't export keys later
- [ ] Store both - `api_key_id` (full) + `api_key_hash` (for lookups)

**Recommendation:** Store **both**:
- `api_key_id VARCHAR(100)` - Full encrypted key (primary key)
- `api_key_hash VARCHAR(64)` - SHA256 hash for MA_VAULT lookups
- Best of both worlds: secure lookups + key export capability

---

### 6. Seal Key Package Mapping Missing ⚠️ MINOR

**SEAL_SERVICE_CONFIG.md and GLOBAL_MANAGER_DESIGN.md expect:**
- Per-key package lists in MA_VAULT

**Current schema:**
- `seal_keys` table has no package relationship

**Decision Required:**
- [ ] Add `seal_key_packages` join table
- [ ] Store packages in `seal_keys.config JSONB` column
- [ ] Package IDs come from on-chain Seal protocol (not in our schema)

**Recommendation:** **Defer to Phase 2+** - This is Seal-protocol-specific and can be added when implementing Seal integration.

---

## Summary Table

| Issue | Severity | Blocking Phase 2? | Decision Needed |
|-------|----------|-------------------|-----------------|
| Monthly limit model conflict | CRITICAL | ✅ YES | Choose: rolling vs calendar |
| Missing status/tier columns | CRITICAL | ✅ YES | Add or simplify |
| customer_id UUID vs INTEGER | CRITICAL | ⚠️ Partial | Fix MM_VAULT FK |
| haproxy_logs column names | MODERATE | ❌ No | Update queries only |
| API key storage method | MODERATE | ⚠️ Maybe | Clarify hash vs full key |
| Seal package mapping | MINOR | ❌ No | Can defer |

---

## Recommended Actions

### Before Phase 2 (Database Implementation):

1. **Choose monthly limit model** (30-day rolling recommended)
2. **Update CUSTOMER_SERVICE_SCHEMA.md** with chosen model
3. **Add missing columns** to `customers` table:
   ```sql
   ALTER TABLE customers ADD COLUMN status VARCHAR(20) DEFAULT 'active';
   -- tier is already in service_instances, don't duplicate
   ```
4. **Add API key hash column**:
   ```sql
   ALTER TABLE api_keys ADD COLUMN api_key_hash VARCHAR(64);
   ```
5. **Fix GLOBAL_MANAGER_DESIGN.md**:
   - Update haproxy_raw_logs column references
   - Fix MM_VAULT customer_id FK type
   - Update MA_VAULT to use service_instances.tier instead of customers.tier

### Can Defer to Later Phases:

6. Seal key package mapping (Phase 7+)
7. API key deinterleave function (Phase 18)

---

## Questions for Decision

1. **Monthly limit model:** 30-day rolling window or calendar month reset?
2. **Default spending cap:** $200 or $2,000?
3. **Limit range:** $20-unlimited or $100-$50k?
4. **Customer status field:** Add to customers table?
5. **API key storage:** Hash only, full key only, or both?

---

**Next Step:** Make decisions on critical issues, then update all docs to be consistent before starting Phase 2 implementation.
