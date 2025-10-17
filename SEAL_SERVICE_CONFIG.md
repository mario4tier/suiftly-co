# Seal Service Configuration

## Overview

This document defines the tier structure, rate limiting, and configuration for the Seal encryption service. It serves as the single source of truth for business logic that affects UI, billing, and infrastructure configuration.

## Service Tiers

### Tier Structure

**NOTE:** See [UI_DESIGN.md](UI_DESIGN.md) for the complete tier pricing and monthly fees. This document focuses on rate limiting configuration.

| Tier | Guaranteed req/s per region | Burst Available | Usage Pricing (all tiers) |
|------|----------------------------|-----------------|---------------------------|
| **Starter** | 100 | ❌ No | $1.00 per 10K requests |
| **Pro** | 500 | ✅ Yes (2x) | $1.00 per 10K requests |
| **Business** | 2000 | ✅ Yes (1.5x) | $1.00 per 10K requests |
| **Enterprise** | Custom | ✅ Yes (Custom) | Custom pricing |

**Key Points:**
- Usage pricing is **$1.00 per 10,000 requests** for all tiers (Starter, Pro, Business)
- Tiers determine **guaranteed bandwidth** (req/s per region), not usage pricing
- Monthly base fees vary by tier (see [UI_DESIGN.md](UI_DESIGN.md#pricing-model))

### Rate Limiting Model

**Key Principles:**
- **Guaranteed req/s**: Hard limit per region - customer always gets this capacity
- **Burst capability**: Available only for Pro and Business tiers
- **No RPM limits**: No per-minute restrictions (only per-second)
- **No connection limits**: No concurrent connection restrictions

**Burst Behavior (Pro/Business only):**
- Allows temporary spikes above guaranteed rate
- Pro: Up to 2x guaranteed rate (200 req/s) for 10 seconds
- Business: Up to 1.5x guaranteed rate (1500 req/s) for 30 seconds
- Burst tokens regenerate at guaranteed rate when below limit

## MA_VAULT Configuration

The MA_VAULT stores customer API keys and rate limits for HAProxy enforcement.

### Entry Format

```json
{
  "customer:<customer_id>": {
    "api_keys": ["<hashed_key1>", "<hashed_key2>"],
    "tier": "pro",
    "limits": {
      "guaranteed_rps": 500,
      "burst_rps": 1000,        // Only for pro/business
      "burst_duration_sec": 10 // Only for pro/business
    },
    "seal_keys": {
      "count": 2,
      "package_ids": ["0x123...", "0x456..."]
    },
    "status": "active"  // active, suspended, throttled
  }
}
```

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

# Apply guaranteed rate limit
http-request deny if { sc_http_req_rate(0) gt var(txn.guaranteed_rps) }

# Burst handling (Pro/Business only) - managed by separate burst table
stick-table type string len 64 size 100k expire 60s \
            store gpc0_rate(10s)  # Burst token bucket
```

### Map File Format

Generated from MA_VAULT by Local Manager:

```
# api_limits.map
# Format: api_key customer_id,tier,guaranteed_rps,burst_rps,status
<api_key_hash> customer123,pro,500,1000,active
<api_key_hash> customer456,starter,100,0,active
<api_key_hash> customer789,business,2000,3000,throttled
```

## Pricing Model

### Usage-Based Billing

- **Billing metric**: Per 10,000 successful requests (2xx/3xx responses)
- **Usage rate**: $1.00 per 10,000 requests (all tiers)
- **Failed requests**: Not charged (4xx/5xx responses)
- **Billing cycle**: Monthly billing at end of month
- **Minimum charge**: $0.01 (rounded up to nearest cent)

**Monthly Base Fees** (see [UI_DESIGN.md](UI_DESIGN.md) for complete pricing):
- Starter: $20/month base + usage fees
- Pro: $40/month base + usage fees
- Business: $80/month base + usage fees

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
- Burst tokens are region-specific

### Example Multi-Region Setup

Pro tier customer (500 req/s guaranteed per region):
- US-East: 500 req/s + burst capability (up to 1000 req/s)
- EU-West: 500 req/s + burst capability (up to 1000 req/s)
- Asia-Pacific: 500 req/s + burst capability (up to 1000 req/s)

Total potential: 1,500 req/s globally (3,000 req/s with burst)

## Monitoring & Alerting

### Customer-Facing Metrics

Available in dashboard:
- Current req/s usage per region
- Burst token availability (Pro/Business)
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