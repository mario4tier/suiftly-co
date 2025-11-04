# Seal Service Configuration

## Overview

This document defines the tier structure, rate limiting, and configuration for the Seal encryption service. It serves as the single source of truth for business logic that affects UI, billing, and infrastructure configuration.

## Service Tiers

### Tier Structure

| Tier | Guaranteed req/s per region | Burst Available |
|------|----------------------------|-----------------|
| **Starter** | 100 | ❌ No |
| **Pro** | 1,000 | ✅ Yes (2x) |
| **Enterprise** | Custom | ✅ Yes (Custom) |

**Key Points:**
- **Usage pricing**: $1.00 per 10,000 requests (same for all tiers)
- Tiers determine **guaranteed bandwidth** (req/s per region), not usage pricing
- Monthly base fees and add-on pricing listed in Pricing Model section below

### Rate Limiting Model

**Key Principles:**
- **Guaranteed req/s**: Hard limit per region - customer always gets this capacity
- **Burst capability**: Available only for Pro and Enterprise tiers
- **No RPM limits**: No per-minute restrictions (only per-second)
- **No connection limits**: No concurrent connection restrictions

**Burst Behavior (Pro/Enterprise only):**
- Best-effort queuing at lower priority than all customers' guaranteed rates
- Requests above guaranteed rate queued with timeout (configured in HAProxy)
- Burst capacity = whatever infrastructure can deliver (not guaranteed)
- Timeout and queuing behavior managed by walrus project (HAProxy config)

## MA_VAULT Configuration

The MA_VAULT stores customer API keys and rate limits for HAProxy enforcement.

### Entry Format

```json
{
  "customer:<customer_id>": {
    "api_keys": ["<hashed_key1>", "<hashed_key2>"],
    "tier": "pro",
    "limits": {
      "guaranteed_rps": 1000,
      "burst_enabled": true      // Pro/Enterprise only
    },
    "seal_keys": {
      "count": 2,
      "package_ids": ["0x123...", "0x456..."]
    },
    "status": "active"  // active, suspended, throttled
  }
}
```

**Note**: Burst timeout (5s) is configured in HAProxy (walrus project), not in MA_VAULT.

### Status Values

- **active**: Normal operation
- **suspended**: No requests allowed (e.g., non-payment)
- **throttled**: Reduced to 50% of guaranteed rate (soft limit)

## HAProxy Integration

### Sticky Table Configuration

HAProxy enforces rate limits using stick tables based on MA_VAULT data:

```haproxy
# Stick table tracks per-customer request rates
stick-table type string len 64 size 100k expire 60s \
            store http_req_rate(1s)

# Guaranteed rate: Immediate deny if exceeded
http-request deny if { sc_http_req_rate(0) gt var(txn.guaranteed_rps) }

# Burst handling (Pro/Enterprise only):
# Requests above guaranteed rate tagged for best-effort processing
# Actual queuing/timeout behavior configured in walrus project
http-request set-var(txn.is_burst) int(1) if { sc_http_req_rate(0) gt var(txn.guaranteed_rps) }
http-request set-header X-Burst-Request true if { var(txn.is_burst) eq 1 }
```

### Map File Format

Generated from MA_VAULT by Global Manager:

```
# api_limits.map
# Format: api_key customer_id,tier,guaranteed_rps,burst_enabled,status
<api_key_hash> customer123,pro,1000,true,active
<api_key_hash> customer456,starter,100,false,active
<api_key_hash> customer789,enterprise,10000,true,active
```

**Note**: HAProxy (walrus project) handles burst timeout configuration, not specified in this map file.

## Pricing Model

### Monthly Base Fees

| Tier | Monthly Base Fee | Description |
|------|-----------------|-------------|
| **Starter** | $20/month | 100 req/s per region, no burst |
| **Pro** | $40/month | 1,000 req/s per region, burst available |
| **Enterprise** | Custom | Custom capacity and pricing |

### Add-On Pricing

| Feature | Cost | Notes |
|---------|------|-------|
| **Burst Capability** | +$10/month | Pro/Enterprise only, allows 2x capacity for 10s |
| **Additional Seal Keys** | +$5/month each | 1 included, additional keys for isolation |
| **Additional Packages** | +$1/month each per seal key | 3 included per seal key |
| **Additional API Keys** | +$1/month each | 1 included, additional for key rotation |

**Pricing Rules:**
- **Seal Keys**: `max(0, totalSealKeys - 1) × $5/month`
- **Packages**: `sum(max(0, packagesPerKey - 3) × $1/month)` for each seal key
- **API Keys**: `max(0, totalApiKeys - 1) × $1/month`
- **Burst**: `$10/month` if enabled (Pro/Enterprise only)

### Usage-Based Billing

- **Billing metric**: Per 10,000 successful requests (2xx/3xx responses)
- **Usage rate**: $1.00 per 10,000 requests (all tiers)
- **Failed requests**: Not charged (4xx/5xx responses)
- **Billing cycle**: Monthly billing at end of month
- **Minimum charge**: $0.01 (rounded up to nearest cent)

### Example Pricing Calculations

**Example 1: Starter Tier**
- Tier: Starter ($20/month)
- Seal Keys: 1 (included)
- Packages: 3 (included)
- API Keys: 1 (included)
- **Total Monthly Fee**: $20/month
- **Usage**: Metered separately at $1/10K requests

**Example 2: Pro Tier (Moderate)**
- Tier: Pro ($40/month)
- Burst: Enabled (+$10/month)
- Seal Keys: 2 (1 included, 1 × $5 = $5/month)
- Packages per key: 5 (3 included, 2 additional × $1 × 2 keys = $4/month)
- API Keys: 2 (1 included, 1 × $1 = $1/month)
- **Total Monthly Fee**: $60/month
- **Usage**: Metered separately at $1/10K requests

**Example 3: Pro Tier (Heavy)**
- Tier: Pro ($40/month)
- Burst: Enabled (+$10/month)
- Seal Keys: 3 (1 included, 2 × $5 = $10/month)
- Packages per key: 5 each (3 included, 2 additional × $1 × 3 keys = $6/month)
- API Keys: 4 (1 included, 3 × $1 = $3/month)
- **Total Monthly Fee**: $69/month
- **Usage**: Metered separately at $1/10K requests

### Tier Selection Guidelines

**Starter Tier:**
- Development and testing
- Low-traffic applications (<100 req/s sustained)
- Personal projects

**Pro Tier:**
- Production applications
- Need for burst capacity
- Medium traffic (up to 500 req/s per region)
- Multiple encryption keys

**Business Tier:**
- High-traffic production (up to 2000 req/s per region)
- Multiple applications/environments
- Extended burst capacity

**Enterprise Tier:**
- Custom SLA requirements
- Dedicated support
- Custom rate limits and pricing

## Regional Deployment

### Rate Limits Per Region

Each region maintains independent rate limits:
- Customer gets full tier capacity in each region
- No cross-region rate limit sharing
- Burst queuing is region-specific

### Example Multi-Region Setup

Pro tier customer (1,000 req/s guaranteed per region):
- US-East: 1,000 req/s guaranteed + best-effort burst
- EU-West: 1,000 req/s guaranteed + best-effort burst
- Asia-Pacific: 1,000 req/s guaranteed + best-effort burst

Total guaranteed: 3,000 req/s globally (burst is best-effort, not guaranteed)

## Monitoring & Alerting

### Customer-Facing Metrics

Available in dashboard:
- Current req/s usage per region
- Burst requests queued/succeeded/timeout count (Pro/Enterprise)
- Daily/Monthly request totals
- Rate limit violations count

### Internal Metrics

For operations team:
- Per-customer req/s trends
- Burst utilization patterns
- Rate limit violation patterns
- Tier distribution analytics

## Migration & Upgrades

### Tier Upgrades

When customer upgrades tier:
1. Update database tier assignment
2. Global Manager generates new MA_VAULT
3. Local Managers apply new limits (~30 second propagation)
4. No service interruption

### Tier Downgrades

When customer downgrades:
1. Effective at next billing cycle
2. Burst capability removed immediately (if applicable)
3. Rate limits adjusted to new tier

## Future Enhancements

Planned improvements (not in MVP):
- Auto-scaling based on usage patterns
- Dynamic burst allocation
- Regional tier differentiation
- Request priority queuing for Enterprise